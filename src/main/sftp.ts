import { randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { readdir, rename, stat, unlink } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { SFTPWrapper } from 'ssh2'
import type { RemoteEntry } from '../shared/types'

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

/** 콜백 API를 Promise로 */
const call = <T = void>(fn: (cb: (err: Error | null | undefined, value?: T) => void) => void) =>
  new Promise<T>((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value as T))))

/** ssh2가 주는 영어 오류를 한국어로 바꾼다. 모르는 오류는 원문을 붙여 둔다. */
export function sftpError(err: unknown, what: string): Error {
  const raw = err instanceof Error ? err.message : String(err)
  const known = /no such file/i.test(raw)
    ? '파일이나 폴더가 없습니다.'
    : /permission denied/i.test(raw)
      ? '권한이 없습니다.'
      : /not a directory/i.test(raw)
        ? '폴더가 아닙니다.'
        : /connection lost|not connected|closed/i.test(raw)
          ? '연결이 끊겼습니다.'
          : /failure/i.test(raw)
            ? '서버가 거부했습니다. 권한이나 대상(폴더가 비어 있는지 등)을 확인하세요.'
            : raw
  return new Error(`${what}: ${known}`)
}

export async function listDir(sftp: SFTPWrapper, path: string): Promise<{ path: string; entries: RemoteEntry[] }> {
  const real = await call<string>((cb) => sftp.realpath(path, cb))
  const list = await call<{ filename: string; attrs: { mode: number; size: number; mtime: number } }[]>((cb) => sftp.readdir(real, cb))
  const entries = list
    .filter((f) => f.filename !== '.' && f.filename !== '..')
    .map((f): RemoteEntry => {
      const kind = f.attrs.mode & S_IFMT
      return {
        name: f.filename,
        type: kind === S_IFDIR ? 'dir' : kind === S_IFLNK ? 'link' : 'file',
        size: f.attrs.size,
        mtime: f.attrs.mtime
      }
    })
    .sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name))
  return { path: real, entries }
}

export const exists = (sftp: SFTPWrapper, path: string) =>
  call<unknown>((cb) => sftp.stat(path, cb)).then(
    () => true,
    () => false
  )

export const mkdir = (sftp: SFTPWrapper, path: string) => call((cb) => sftp.mkdir(path, cb))
export const renamePath = (sftp: SFTPWrapper, from: string, to: string) => call((cb) => sftp.rename(from, to, cb))
/** 폴더는 비어 있을 때만 지운다. */
// ponytail: 재귀 삭제 없음. 필요해지면 심볼릭 링크를 따라가지 않는 재귀로 추가.
export const removePath = (sftp: SFTPWrapper, path: string, isDir: boolean) =>
  call((cb) => (isDir ? sftp.rmdir(path, cb) : sftp.unlink(path, cb)))

type Progress = (done: number, total: number) => void

/** 임시 이름으로 올린 뒤 끝나면 최종 이름으로 바꾼다. 실패하거나 취소되면 임시 파일을 지운다. */
export async function upload(sftp: SFTPWrapper, local: string, remote: string, onProgress: Progress, signal: AbortSignal) {
  const total = (await stat(local)).size
  const tmp = `${remote}.part-${randomBytes(4).toString('hex')}`
  let done = 0
  const src = createReadStream(local)
  src.on('data', (c) => onProgress((done += c.length), total))
  try {
    await pipeline(src, sftp.createWriteStream(tmp), { signal })
    // 대상이 있으면 OpenSSH의 덮어쓰기 rename을 쓰고, 없는 서버면 지우고 바꾼다.
    try {
      await call((cb) => sftp.ext_openssh_rename(tmp, remote, cb))
    } catch {
      if (await exists(sftp, remote)) await call((cb) => sftp.unlink(remote, cb))
      await renamePath(sftp, tmp, remote)
    }
  } catch (err) {
    await call((cb) => sftp.unlink(tmp, cb)).catch(() => {})
    throw err
  }
}

export async function download(sftp: SFTPWrapper, remote: string, local: string, onProgress: Progress, signal: AbortSignal) {
  const { size: total } = await call<{ size: number }>((cb) => sftp.stat(remote, cb))
  const tmp = `${local}.part`
  let done = 0
  const src = sftp.createReadStream(remote)
  src.on('data', (c: Buffer) => onProgress((done += c.length), total))
  try {
    await pipeline(src, createWriteStream(tmp), { signal })
    await rename(tmp, local)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}

export const remoteJoin = posix.join

export interface TreeEntry {
  /** 루트 기준 상대 경로 ('/' 구분) */
  rel: string
  isDir: boolean
}

/** 로컬 폴더 전체 목록. 심볼릭 링크는 따라가지 않는다. */
export async function walkLocal(root: string, rel = ''): Promise<TreeEntry[]> {
  const out: TreeEntry[] = []
  for (const d of await readdir(join(root, rel), { withFileTypes: true })) {
    if (d.isSymbolicLink()) continue
    const r = rel ? `${rel}/${d.name}` : d.name
    if (d.isDirectory()) out.push({ rel: r, isDir: true }, ...(await walkLocal(root, r)))
    else if (d.isFile()) out.push({ rel: r, isDir: false })
  }
  return out
}

/** 원격 폴더 전체 목록. 링크는 따라가지 않는다. */
export async function walkRemote(sftp: SFTPWrapper, root: string, rel = ''): Promise<TreeEntry[]> {
  const out: TreeEntry[] = []
  const list = await call<{ filename: string; attrs: { mode: number } }[]>((cb) => sftp.readdir(rel ? posix.join(root, rel) : root, cb))
  for (const f of list) {
    if (f.filename === '.' || f.filename === '..') continue
    const kind = f.attrs.mode & S_IFMT
    const r = rel ? `${rel}/${f.filename}` : f.filename
    if (kind === S_IFDIR) out.push({ rel: r, isDir: true }, ...(await walkRemote(sftp, root, r)))
    else if (kind !== S_IFLNK) out.push({ rel: r, isDir: false })
  }
  return out
}

/** 이미 있으면 그냥 넘어간다. */
export const ensureRemoteDir = (sftp: SFTPWrapper, path: string) =>
  exists(sftp, path).then((ok) => (ok ? undefined : mkdir(sftp, path)))
