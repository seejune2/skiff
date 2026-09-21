import { createHash } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { RemoteEdit } from '../shared/types'
import { download, upload } from './sftp'

/** 편집기가 저장할 때 임시 파일을 거치는 경우가 많아, 조금 기다렸다가 한 번만 올린다. */
const SAVE_DEBOUNCE = 400
const MAX_EDIT_SIZE = 20 * 1024 * 1024

interface Edit {
  connId: string
  remote: string
  local: string
  watcher: FSWatcher
  timer?: NodeJS.Timeout
  hash: string
}

const hashOf = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')

export class RemoteEdits {
  private readonly edits = new Map<string, Edit>()

  constructor(
    private readonly tempDir: string,
    private readonly getSftp: (connId: string) => Promise<SFTPWrapper>,
    private readonly onStatus: (status: RemoteEdit) => void
  ) {}

  list(): RemoteEdit[] {
    return [...this.edits.values()].map(({ connId, remote, local }) => ({ connId, remote, local, state: 'open' }))
  }

  /** 원격 파일을 임시 폴더에 받아 두고 감시를 건다. 이미 열려 있으면 그 경로를 그대로 준다. */
  async open(connId: string, remote: string): Promise<string> {
    const existing = [...this.edits.values()].find((e) => e.connId === connId && e.remote === remote)
    if (existing) return existing.local
    const sftp = await this.getSftp(connId)
    const local = join(this.tempDir, connId, basename(remote) || 'file')
    await mkdir(dirname(local), { recursive: true })
    let size = 0
    await download(sftp, remote, local, (_done, total) => (size = total), new AbortController().signal)
    if (size > MAX_EDIT_SIZE) {
      await rm(local, { force: true })
      throw new Error('20MB보다 큰 파일은 편집으로 열지 않습니다. 다운로드를 쓰세요.')
    }
    const hash = hashOf(await readFile(local))
    // 편집기가 파일을 지웠다 다시 만드는 경우까지 잡으려고 폴더를 감시한다.
    const watcher = watch(dirname(local), (_type, name) => {
      if (name && basename(name) !== basename(local)) return
      const edit = this.edits.get(local)
      if (!edit) return
      clearTimeout(edit.timer)
      edit.timer = setTimeout(() => void this.push(local), SAVE_DEBOUNCE)
    })
    this.edits.set(local, { connId, remote, local, watcher, hash })
    this.report(this.edits.get(local)!, 'open')
    return local
  }

  /** IPC로는 직렬화되는 값만 보낸다 (watcher, timer 제외). */
  private report(edit: Edit, state: RemoteEdit['state'], message?: string): void {
    this.onStatus({ connId: edit.connId, remote: edit.remote, local: edit.local, state, message })
  }

  private async push(local: string): Promise<void> {
    const edit = this.edits.get(local)
    if (!edit) return
    try {
      const data = await readFile(local)
      const hash = hashOf(data)
      if (hash === edit.hash) return
      this.report(edit, 'uploading')
      // ponytail: 서버 쪽이 그사이 바뀌었는지는 보지 않는다. 충돌 검사는 필요해지면 mtime 비교로.
      await upload(await this.getSftp(edit.connId), local, edit.remote, () => {}, new AbortController().signal)
      edit.hash = hash
      this.report(edit, 'saved')
    } catch (err) {
      this.report(edit, 'error', (err as Error).message)
    }
  }

  async close(local: string): Promise<void> {
    const edit = this.edits.get(local)
    if (!edit) return
    clearTimeout(edit.timer)
    edit.watcher.close()
    this.edits.delete(local)
    await rm(local, { force: true })
    this.report(edit, 'closed')
  }

  /** 연결이 끊기거나 앱이 닫힐 때 */
  closeAll(connId?: string): void {
    for (const edit of [...this.edits.values()]) if (!connId || edit.connId === connId) void this.close(edit.local)
  }
}
