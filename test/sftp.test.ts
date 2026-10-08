import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, Server, utils, type SFTPWrapper } from 'ssh2'
import { chmod, download, ensureRemoteDir, listDir, partName, sftpError, upload, walkLocal, walkRemote } from '../src/main/sftp'
import { RemoteEdits } from '../src/main/edits'
import type { RemoteEdit } from '../src/shared/types'

const { STATUS_CODE, flagsToString } = utils.sftp

/** 서버가 받은 SETSTAT 권한. Windows에서는 fs.chmod가 권한 비트를 대부분 무시해서 받은 값으로 확인한다. */
const setstats: { path: string; mode?: number }[] = []

/** 임시 폴더를 루트(/)로 쓰는 최소 SFTP 서버. 실제 OpenSSH처럼 대상이 있으면 rename을 거부한다. */
function startSftpServer(root: string) {
  const local = (p: string) => join(root, p.replace(/^\/+/, ''))
  const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept())
    client.on('error', () => {})
    client.on('session', (accept) =>
      accept().on('sftp', (acc) => {
        const sftp = acc()
        const handles = new Map<number, { fd?: number; dir?: string; listed?: boolean }>()
        let next = 0
        const newHandle = (v: { fd?: number; dir?: string }) => {
          const h = Buffer.alloc(4)
          h.writeUInt32BE(++next)
          handles.set(next, v)
          return h
        }
        const get = (h: Buffer) => handles.get(h.readUInt32BE(0))!
        const attrs = (st: fs.Stats) => ({ mode: st.mode, size: st.size, uid: 0, gid: 0, atime: st.atimeMs / 1000, mtime: st.mtimeMs / 1000 })
        const tryDo = (id: number, fn: () => void) => {
          try {
            fn()
            sftp.status(id, STATUS_CODE.OK)
          } catch {
            sftp.status(id, STATUS_CODE.FAILURE)
          }
        }
        sftp.on('OPEN', (id, path, flags) => sftp.handle(id, newHandle({ fd: fs.openSync(local(path), flagsToString(flags)!) })))
        sftp.on('WRITE', (id, h, offset, data) => tryDo(id, () => fs.writeSync(get(h).fd!, data, 0, data.length, offset)))
        sftp.on('READ', (id, h, offset, len) => {
          const buf = Buffer.alloc(len)
          const n = fs.readSync(get(h).fd!, buf, 0, len, offset)
          if (n === 0) sftp.status(id, STATUS_CODE.EOF)
          else sftp.data(id, buf.subarray(0, n))
        })
        sftp.on('CLOSE', (id, h) => tryDo(id, () => get(h).fd !== undefined && fs.closeSync(get(h).fd!)))
        const statPath = (id: number, path: string) => {
          if (!fs.existsSync(local(path))) return sftp.status(id, STATUS_CODE.NO_SUCH_FILE)
          sftp.attrs(id, attrs(fs.statSync(local(path))))
        }
        sftp.on('STAT', statPath)
        sftp.on('LSTAT', statPath)
        sftp.on('FSTAT', (id, h) => sftp.attrs(id, attrs(fs.fstatSync(get(h).fd!))))
        sftp.on('REALPATH', (id, path) => sftp.name(id, [{ filename: path === '.' ? '/' : path, longname: '', attrs: {} as never }]))
        sftp.on('OPENDIR', (id, path) => sftp.handle(id, newHandle({ dir: local(path) })))
        sftp.on('READDIR', (id, h) => {
          const d = get(h)
          if (d.listed) return sftp.status(id, STATUS_CODE.EOF)
          d.listed = true
          sftp.name(
            id,
            fs.readdirSync(d.dir!).map((name) => ({ filename: name, longname: name, attrs: attrs(fs.statSync(join(d.dir!, name))) as never }))
          )
        })
        sftp.on('RENAME', (id, from, to) =>
          tryDo(id, () => {
            if (fs.existsSync(local(to))) throw new Error('exists')
            fs.renameSync(local(from), local(to))
          })
        )
        sftp.on('REMOVE', (id, path) => tryDo(id, () => fs.unlinkSync(local(path))))
        sftp.on('SETSTAT', (id, path, a) => tryDo(id, () => setstats.push({ path, mode: a.mode })))
        sftp.on('MKDIR', (id, path) => tryDo(id, () => fs.mkdirSync(local(path))))
      })
    )
  })
  return new Promise<{ port: number; close(): void }>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, close: () => server.close() }))
  )
}

const hash = (path: string) => createHash('sha256').update(fs.readFileSync(path)).digest('hex')

let root: string
let localDir: string
let client: Client
let sftp: SFTPWrapper
let server: { port: number; close(): void }

beforeAll(async () => {
  root = fs.mkdtempSync(join(tmpdir(), 'sftp-remote-'))
  localDir = fs.mkdtempSync(join(tmpdir(), 'sftp-local-'))
  server = await startSftpServer(root)
  client = new Client()
  await new Promise<void>((resolve) => {
    client.on('ready', () => client.sftp((err, s) => ((sftp = s), resolve())))
    client.connect({ host: '127.0.0.1', port: server.port, username: 'u', hostVerifier: () => true })
  })
})
afterAll(() => {
  client.end()
  server.close()
})

const noop = () => {}

it('업로드와 다운로드 후 해시가 같고, 덮어쓰기와 목록이 된다', async () => {
  const src = join(localDir, '원본.bin')
  fs.writeFileSync(src, randomBytes(3 * 1024 * 1024 + 123))
  await upload(sftp, src, '/원본.bin', noop, new AbortController().signal)
  expect(hash(join(root, '원본.bin'))).toBe(hash(src))

  // 덮어쓰기: 서버 rename이 대상 있음으로 실패해도 지우고 바꾼다.
  fs.writeFileSync(src, 'changed')
  await upload(sftp, src, '/원본.bin', noop, new AbortController().signal)
  expect(fs.readFileSync(join(root, '원본.bin'), 'utf8')).toBe('changed')

  const dst = join(localDir, '받은.bin')
  await download(sftp, '/원본.bin', dst, noop, new AbortController().signal)
  expect(hash(dst)).toBe(hash(src))

  const { path, entries } = await listDir(sftp, '.')
  expect(path).toBe('/')
  expect(entries.map((e) => e.name)).toEqual(['원본.bin'])
})

it('취소하면 완성 파일도 임시 파일도 남지 않는다', async () => {
  const src = join(localDir, 'big.bin')
  fs.writeFileSync(src, randomBytes(8 * 1024 * 1024))
  const abort = new AbortController()
  await expect(upload(sftp, src, '/big.bin', () => abort.abort(), abort.signal)).rejects.toThrow()
  // 원격 쪽 닫기/삭제가 끝날 시간을 준다.
  await new Promise((r) => setTimeout(r, 200))
  expect(fs.readdirSync(root).filter((n) => n.startsWith('big.bin'))).toEqual([])

  await upload(sftp, src, '/big.bin', noop, new AbortController().signal)
  const abort2 = new AbortController()
  const dst = join(localDir, 'big-down.bin')
  await expect(download(sftp, '/big.bin', dst, () => abort2.abort(), abort2.signal)).rejects.toThrow()
  expect(fs.readdirSync(localDir).filter((n) => n.startsWith('big-down'))).toEqual([])
})

it('폴더 전체를 로컬과 원격에서 같은 모양으로 훑는다', async () => {
  const src = join(localDir, '트리')
  fs.mkdirSync(join(src, 'a', 'b'), { recursive: true })
  fs.writeFileSync(join(src, 'top.txt'), '1')
  fs.writeFileSync(join(src, 'a', 'b', 'deep.txt'), '2')
  const local = await walkLocal(src)
  expect(local.map((e) => `${e.rel}${e.isDir ? '/' : ''}`).sort()).toEqual(['a/', 'a/b/', 'a/b/deep.txt', 'top.txt'])

  // 폴더 업로드와 같은 순서: 폴더 먼저, 파일은 그다음
  await ensureRemoteDir(sftp, '/트리')
  await ensureRemoteDir(sftp, '/트리') // 이미 있어도 오류 없음
  for (const e of local) {
    if (e.isDir) await ensureRemoteDir(sftp, `/트리/${e.rel}`)
    else await upload(sftp, join(src, e.rel), `/트리/${e.rel}`, noop, new AbortController().signal)
  }
  const remote = await walkRemote(sftp, '/트리')
  expect(remote.map((e) => `${e.rel}${e.isDir ? '/' : ''}`).sort()).toEqual(['a/', 'a/b/', 'a/b/deep.txt', 'top.txt'])
  expect(fs.readFileSync(join(root, '트리', 'a', 'b', 'deep.txt'), 'utf8')).toBe('2')
})

it('SFTP 오류를 한국어로 바꾼다', () => {
  expect(sftpError(new Error('No such file'), '목록을 읽지 못했습니다').message).toBe('목록을 읽지 못했습니다: 파일이나 폴더가 없습니다.')
  expect(sftpError(new Error('Permission denied'), '삭제하지 못했습니다').message).toContain('권한이 없습니다')
  expect(sftpError(new Error('Failure'), '삭제하지 못했습니다').message).toContain('비어 있는지')
  // 모르는 오류는 원문을 남긴다
  expect(sftpError(new Error('Weird error 42'), '업로드 실패').message).toBe('업로드 실패: Weird error 42')
})

it('목록에 권한 비트가 오고, chmod가 서버에 그 값을 보낸다', async () => {
  fs.writeFileSync(join(root, 'perm.txt'), 'x')
  const { entries } = await listDir(sftp, '/')
  expect(entries.find((e) => e.name === 'perm.txt')!.mode).toBe(fs.statSync(join(root, 'perm.txt')).mode & 0o7777)
  await chmod(sftp, '/perm.txt', 0o640)
  expect(setstats.at(-1)).toEqual({ path: '/perm.txt', mode: 0o640 })
})

it('원격 편집: 연 뒤 서버 파일이 바뀌었으면 묻고, 거절하면 올리지 않는다', async () => {
  fs.writeFileSync(join(root, 'edit.txt'), 'v1')
  const statuses: RemoteEdit[] = []
  let answer = false
  const asked: string[] = []
  const edits = new RemoteEdits(
    join(localDir, 'edit-tmp'),
    async () => sftp,
    (s) => statuses.push(s),
    async (remote) => (asked.push(remote), answer)
  )
  const local = await edits.open('c1', '/edit.txt')
  const waitFor = async (state: RemoteEdit['state']) => {
    const from = statuses.length
    for (let i = 0; i < 50 && !statuses.slice(from).some((s) => s.state === state); i++) await new Promise((r) => setTimeout(r, 100))
    expect(statuses.slice(from).map((s) => s.state)).toContain(state)
  }

  // 서버 쪽이 바뀌지 않았으면 묻지 않고 올린다.
  fs.writeFileSync(local, 'mine1')
  await waitFor('saved')
  expect(asked).toEqual([])
  expect(fs.readFileSync(join(root, 'edit.txt'), 'utf8')).toBe('mine1')

  // 다른 사람이 서버 파일을 바꿈 (크기가 달라 mtime이 같아도 잡힌다)
  fs.writeFileSync(join(root, 'edit.txt'), 'someone else')
  fs.writeFileSync(local, 'mine2')
  await waitFor('error')
  expect(asked).toEqual(['/edit.txt'])
  expect(fs.readFileSync(join(root, 'edit.txt'), 'utf8')).toBe('someone else')

  // 다시 저장하고 덮어쓰기를 고르면 올라간다.
  answer = true
  fs.writeFileSync(local, 'mine3')
  await waitFor('saved')
  expect(fs.readFileSync(join(root, 'edit.txt'), 'utf8')).toBe('mine3')
  await edits.close(local)
})

it('끊겨서 남은 임시 파일이 있으면 그 뒤부터 이어서 올리고 받는다', async () => {
  const data = randomBytes(2 * 1024 * 1024)
  const src = join(localDir, 'resume.bin')
  fs.writeFileSync(src, data)
  const half = data.length / 2

  // 올리다 끊긴 상태: 서버에 앞 절반짜리 임시 파일
  const st = fs.statSync(src)
  fs.writeFileSync(join(root, partName('resume.bin', st.size, st.mtimeMs)), data.subarray(0, half))
  const firsts: number[] = []
  await upload(sftp, src, '/resume.bin', (done) => firsts.push(done), new AbortController().signal)
  expect(firsts[0]).toBeGreaterThan(half)
  expect(hash(join(root, 'resume.bin'))).toBe(hash(src))
  expect(fs.readdirSync(root).filter((n) => n.startsWith('resume.bin.part'))).toEqual([])

  // 받다 끊긴 상태: 로컬에 앞 절반짜리 임시 파일
  const dst = join(localDir, 'resume-down.bin')
  const rst = fs.statSync(join(root, 'resume.bin'))
  fs.writeFileSync(partName(dst, rst.size, rst.mtimeMs / 1000), data.subarray(0, half))
  const downs: number[] = []
  await download(sftp, '/resume.bin', dst, (done) => downs.push(done), new AbortController().signal)
  expect(downs[0]).toBeGreaterThan(half)
  expect(hash(dst)).toBe(hash(src))

  // 원본이 바뀌면 이름이 달라져서 처음부터 한다.
  fs.writeFileSync(src, 'new')
  await upload(sftp, src, '/resume.bin', noop, new AbortController().signal)
  expect(fs.readFileSync(join(root, 'resume.bin'), 'utf8')).toBe('new')
})
