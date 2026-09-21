import { spawn } from 'node:child_process'
import { mkdir as mkdirLocal, stat as statLocal } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, posix } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { ConnStatus, PromptBody, PromptReply, Session, Snippet, Transfer } from '../shared/types'
import { readJson, writeJson } from './jsonFile'
import { KnownHosts } from './knownHosts'
import { LocalShells } from './local'
import { SessionLogs } from './logs'
import { Secrets } from './secrets'
import { SessionStore, validateSession } from './sessions'
import { SettingsStore } from './settings'
import { download, ensureRemoteDir, exists, listDir, mkdir, remoteJoin, removePath, renamePath, sftpError, upload, walkLocal, walkRemote } from './sftp'
import { SshManager } from './ssh'

const dataDir = app.getPath('userData')

// 이름이 SSH Workbench에서 Skiff로 바뀌면서 userData 경로도 바뀌었다. 예전 설정을 한 번만 옮긴다.
// ponytail: 다음 버전에서 지워도 되는 임시 코드.
function migrateOldData(): void {
  const old = join(dirname(dataDir), 'SSH Workbench')
  if (!existsSync(old) || existsSync(join(dataDir, 'sessions.json'))) return
  mkdirSync(dataDir, { recursive: true })
  for (const name of ['sessions.json', 'settings.json', 'known_hosts.json', 'snippets.json', 'secrets.json']) {
    const from = join(old, name)
    if (existsSync(from)) copyFileSync(from, join(dataDir, name))
  }
}
migrateOldData()
const sessions = new SessionStore(join(dataDir, 'sessions.json'))
const secrets = new Secrets(join(dataDir, 'secrets.json'))
const tempSessions = new Map<string, Session>()
const settings = new SettingsStore(join(dataDir, 'settings.json'))
const logs = new SessionLogs(join(app.getPath('documents'), 'Skiff Logs'))
const pendingPrompts = new Map<string, { body: PromptBody; resolve: (reply: PromptReply) => void }>()
let win: BrowserWindow | null = null

const send = (channel: string, ...args: unknown[]) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

// SSH와 로컬 셸 출력은 모두 여기를 거친다: 화면으로 보내고, 로그가 켜져 있으면 파일에도 쓴다.
const termData = (connId: string, data: Uint8Array) => {
  logs.write(connId, data)
  send('ssh:data', connId, data)
}
const termStatus = (status: ConnStatus) => {
  if (status.state === 'closed' || status.state === 'error') logs.stop(status.connId)
  send('ssh:status', status)
}

const X11_PORT = 6000 // DISPLAY :0
const VCXSRV = 'C:\\Program Files\\VcXsrv\\vcxsrv.exe'

const xServerUp = () =>
  new Promise<boolean>((resolve) => {
    const s = connect(X11_PORT, '127.0.0.1', () => (s.destroy(), resolve(true)))
    s.on('error', () => resolve(false))
  })

/** 로컬 X 서버가 없으면 Windows에서는 VcXsrv를 띄운다. 실패하면 안내 문구. */
// ponytail: DISPLAY :0 고정. 다른 디스플레이 번호가 필요해지면 세션 설정으로 뺀다.
async function prepareX11(): Promise<string | null> {
  if (await xServerUp()) return null
  if (process.platform !== 'win32') return '로컬 X 서버(:0)가 실행 중이 아닙니다. macOS는 XQuartz를 실행하세요.'
  if (!existsSync(VCXSRV)) return 'VcXsrv가 설치되어 있지 않습니다. winget install marha.VcXsrv 로 설치하세요.'
  // -ac(접근 제어 끄기)는 쓰지 않는다. VcXsrv는 X0.hosts의 localhost만 허용한다.
  spawn(VCXSRV, [':0', '-multiwindow', '-clipboard', '-wgl'], { detached: true, stdio: 'ignore' }).unref()
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (await xServerUp()) return null
  }
  return 'VcXsrv를 시작하지 못했습니다. XLaunch로 직접 실행해 보세요.'
}

const ssh = new SshManager({
  x11: { port: X11_PORT, prepare: prepareX11 },
  knownHosts: new KnownHosts(join(dataDir, 'known_hosts.json')),
  passwords: {
    canSave: (id) => !tempSessions.has(id) && secrets.available(),
    get: (id) => secrets.get(id),
    save: (id, pw) => secrets.save(id, pw)
  },
  prompt: (connId, body) =>
    new Promise((resolve) => {
      if (!win || win.isDestroyed()) return resolve(null)
      const id = randomUUID()
      pendingPrompts.set(id, { body, resolve })
      send('prompt:request', { ...body, id, connId })
    }),
  onData: termData,
  onStatus: termStatus,
  onTunnel: (status) => send('tunnels:status', status)
})

// 로컬 셸도 SSH와 같은 ssh:data / ssh:status 채널과 connId 공간을 쓴다. 터미널 화면은 둘을 구분하지 않는다.
const local = new LocalShells(termData, termStatus)

/** renderer 응답이 프롬프트 종류에 맞지 않으면 취소로 본다. */
function checkReply(body: PromptBody, reply: unknown): PromptReply {
  switch (body.kind) {
    case 'hostkey':
      return reply === true ? true : null
    case 'password':
    case 'passphrase': {
      const r = reply as { value?: unknown; save?: unknown } | null
      return r && typeof r.value === 'string' ? { value: r.value, save: body.kind === 'password' && r.save === true } : null
    }
    case 'keyboard-interactive':
      return Array.isArray(reply) && reply.length === body.prompts.length && reply.every((a) => typeof a === 'string')
        ? reply
        : null
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64
const isSize = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) <= 1000

const isPath = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096

// 전송 작업. 재시도할 수 있게 실행 함수를 남겨 둔다.
const transfers = new Map<string, { status: Transfer; run(signal: AbortSignal): Promise<void>; abort?: AbortController }>()

// 폴더 전송에서 수백 개가 한꺼번에 돌지 않게 동시에 몇 개만 실행하고 나머지는 대기시킨다.
const MAX_RUNNING = 3

function pumpTransfers(): void {
  let running = [...transfers.values()].filter((t) => t.status.state === 'running').length
  for (const [id, t] of transfers) {
    if (running >= MAX_RUNNING) break
    if (t.status.state !== 'queued') continue
    running++
    startTransfer(id)
  }
}

function startTransfer(id: string): void {
  const t = transfers.get(id)
  if (!t) return
  const abort = new AbortController()
  t.abort = abort
  Object.assign(t.status, { state: 'running', done: 0, message: undefined })
  send('sftp:transfer', t.status)
  t.run(abort.signal).then(
    () => Object.assign(t.status, { state: 'done', done: t.status.total }),
    (err: Error) =>
      Object.assign(t.status, abort.signal.aborted ? { state: 'cancelled' } : { state: 'error', message: err.message })
  ).finally(() => {
    send('sftp:transfer', t.status)
    pumpTransfers()
  })
}

function addTransfer(
  connId: string,
  direction: Transfer['direction'],
  name: string,
  job: (signal: AbortSignal, progress: (done: number, total: number) => void) => Promise<void>
): void {
  const id = randomUUID()
  const status: Transfer = { id, connId, direction, name, done: 0, total: 0, state: 'queued' }
  let last = 0
  const progress = (done: number, total: number) => {
    Object.assign(status, { done, total })
    // 이벤트가 너무 잦지 않게 0.2초마다 보낸다.
    if (Date.now() - last > 200) {
      last = Date.now()
      send('sftp:transfer', status)
    }
  }
  transfers.set(id, { status, run: (signal) => job(signal, progress) })
  send('sftp:transfer', status)
  pumpTransfers()
}

async function askOverwrite(name: string, folder = false): Promise<boolean> {
  const { response } = await dialog.showMessageBox(win!, {
    type: 'question',
    buttons: ['덮어쓰기', '건너뛰기'],
    defaultId: 1,
    cancelId: 1,
    message: folder ? `"${name}" 폴더가 이미 있습니다. 안의 같은 이름 파일을 덮어쓸까요?` : `"${name}" 파일이 이미 있습니다. 덮어쓸까요?`
  })
  return response === 0
}

// 재시도 때 연결이 다시 열렸을 수 있으니 SFTP 채널은 실행할 때 가져온다.
const queueUpload = (connId: string, local: string, remote: string) =>
  addTransfer(connId, 'upload', posix.basename(remote), async (signal, progress) =>
    upload(await ssh.sftp(connId), local, remote, progress, signal).catch((err) => {
      throw sftpError(err, '업로드 실패')
    })
  )
const queueDownload = (connId: string, remote: string, local: string) =>
  addTransfer(connId, 'download', posix.basename(remote), async (signal, progress) =>
    download(await ssh.sftp(connId), remote, local, progress, signal).catch((err) => {
      throw sftpError(err, '다운로드 실패')
    })
  )

/** 로컬 파일이나 폴더 하나를 원격 dir 아래로 올린다. */
async function uploadPath(connId: string, local: string, dir: string): Promise<void> {
  const sftp = await ssh.sftp(connId)
  const name = basename(local)
  const remote = remoteJoin(dir, name)
  const isDir = (await statLocal(local)).isDirectory()
  if ((await exists(sftp, remote)) && !(await askOverwrite(name, isDir))) return
  if (!isDir) return queueUpload(connId, local, remote)
  await ensureRemoteDir(sftp, remote)
  for (const e of await walkLocal(local)) {
    const target = remoteJoin(remote, e.rel)
    // 폴더는 순서대로 먼저 만들어 두고 파일은 대기열로 보낸다.
    if (e.isDir) await ensureRemoteDir(sftp, target)
    else queueUpload(connId, join(local, e.rel), target)
  }
}

function registerSftpIpc(): void {
  const withSftp = <A extends unknown[], R>(fn: (sftp: Awaited<ReturnType<SshManager['sftp']>>, ...args: A) => Promise<R>) =>
    async (_e: unknown, connId: unknown, ...args: A) => {
      if (!isId(connId)) throw new Error('잘못된 연결입니다.')
      return fn(await ssh.sftp(connId), ...args)
    }
  const label = (what: string) => (err: unknown) => {
    throw sftpError(err, what)
  }
  ipcMain.handle(
    'sftp:list',
    withSftp((sftp, path: unknown) => listDir(sftp, isPath(path) ? path : '.').catch(label('목록을 읽지 못했습니다')))
  )
  ipcMain.handle('sftp:mkdir', withSftp(async (sftp, path: unknown) => {
    if (isPath(path)) await mkdir(sftp, path).catch(label('폴더를 만들지 못했습니다'))
  }))
  ipcMain.handle('sftp:rename', withSftp(async (sftp, from: unknown, to: unknown) => {
    if (isPath(from) && isPath(to)) await renamePath(sftp, from, to).catch(label('이름을 바꾸지 못했습니다'))
  }))
  ipcMain.handle('sftp:delete', withSftp(async (sftp, path: unknown, isDir: unknown) => {
    if (isPath(path)) await removePath(sftp, path, isDir === true).catch(label('삭제하지 못했습니다'))
  }))

  // 로컬 경로는 renderer에서 받지 않고 main의 파일 대화상자로만 정한다.
  ipcMain.handle('sftp:upload', async (_e, connId: unknown, dir: unknown) => {
    if (!isId(connId) || !isPath(dir)) return
    const picked = await dialog.showOpenDialog(win!, { title: '업로드할 파일', properties: ['openFile', 'multiSelections'] })
    for (const local of picked.filePaths) await uploadPath(connId, local, dir)
  })
  ipcMain.handle('sftp:uploadFolder', async (_e, connId: unknown, dir: unknown) => {
    if (!isId(connId) || !isPath(dir)) return
    const picked = await dialog.showOpenDialog(win!, { title: '업로드할 폴더', properties: ['openDirectory'] })
    for (const local of picked.filePaths) await uploadPath(connId, local, dir)
  })
  // 드래그앤드롭: 사용자가 탐색기에서 끌어다 놓은 경로만 들어온다. 절대 경로인지 다시 확인한다.
  ipcMain.handle('sftp:uploadPaths', async (_e, connId: unknown, dir: unknown, paths: unknown) => {
    if (!isId(connId) || !isPath(dir) || !Array.isArray(paths)) return
    for (const p of paths.slice(0, 500)) if (isPath(p) && isAbsolute(p)) await uploadPath(connId, p, dir)
  })
  ipcMain.handle('sftp:downloadFolder', async (_e, connId: unknown, remote: unknown) => {
    if (!isId(connId) || !isPath(remote)) return
    const sftp = await ssh.sftp(connId)
    const picked = await dialog.showOpenDialog(win!, { title: '받을 위치 선택', defaultPath: app.getPath('downloads'), properties: ['openDirectory'] })
    if (picked.canceled || !picked.filePaths[0]) return
    const name = posix.basename(remote)
    const root = join(picked.filePaths[0], name)
    if ((await statLocal(root).then(() => true, () => false)) && !(await askOverwrite(name, true))) return
    await mkdirLocal(root, { recursive: true })
    for (const e of await walkRemote(sftp, remote)) {
      const target = join(root, ...e.rel.split('/'))
      if (e.isDir) await mkdirLocal(target, { recursive: true })
      else queueDownload(connId, remoteJoin(remote, e.rel), target)
    }
  })
  ipcMain.handle('sftp:download', async (_e, connId: unknown, remote: unknown) => {
    if (!isId(connId) || !isPath(remote)) return
    const name = remote.split('/').pop()!
    const picked = await dialog.showSaveDialog(win!, { title: '다운로드', defaultPath: join(app.getPath('downloads'), name) })
    if (picked.canceled || !picked.filePath) return
    queueDownload(connId, remote, picked.filePath)
  })
  ipcMain.on('sftp:cancel', (_e, id: unknown) => {
    const t = isId(id) ? transfers.get(id) : undefined
    if (!t) return
    if (t.status.state === 'queued') {
      t.status.state = 'cancelled'
      send('sftp:transfer', t.status)
    } else t.abort?.abort()
  })
  ipcMain.on('sftp:retry', (_e, id: unknown) => {
    const t = isId(id) ? transfers.get(id) : undefined
    if (t && (t.status.state === 'error' || t.status.state === 'cancelled')) {
      t.status.state = 'queued'
      send('sftp:transfer', t.status)
      pumpTransfers()
    }
  })
  ipcMain.on('sftp:forget', (_e, id: unknown) => {
    if (isId(id) && transfers.get(id)?.status.state !== 'running') transfers.delete(id as string)
  })
}

function registerIpc(): void {
  registerSftpIpc()
  ipcMain.handle('sessions:list', () => sessions.list())
  ipcMain.handle('sessions:save', (_e, input: unknown) => sessions.save(input))
  ipcMain.handle('sessions:temp', (_e, input: unknown) => {
    const valid = validateSession(input)
    const privateKeyPath = valid.privateKeyPath.replace(/^~(?=$|[\\/])/, homedir())
    const session: Session = { ...valid, privateKeyPath, id: randomUUID(), temp: true }
    tempSessions.set(session.id, session)
    return session
  })
  ipcMain.handle('sessions:delete', (_e, id: unknown) => {
    if (!isId(id)) return
    sessions.delete(id)
    secrets.delete(id)
  })
  ipcMain.handle('sessions:pickKey', async () => {
    const result = await dialog.showOpenDialog(win!, {
      title: '개인키 파일 선택',
      defaultPath: join(app.getPath('home'), '.ssh'),
      properties: ['openFile', 'showHiddenFiles']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('secrets:available', () => secrets.available())
  ipcMain.handle('secrets:has', (_e, id: unknown) => isId(id) && secrets.has(id))
  ipcMain.handle('secrets:delete', (_e, id: unknown) => {
    if (isId(id)) secrets.delete(id)
  })

  // connId는 renderer가 만든다. 그래야 connect 응답보다 먼저 오는 상태 이벤트도 탭에 연결된다.
  ipcMain.handle('ssh:connect', (_e, sessionId: unknown, connId: unknown, cols: unknown, rows: unknown) => {
    const session = isId(sessionId) ? (sessions.get(sessionId) ?? tempSessions.get(sessionId)) : undefined
    if (!session) throw new Error('세션을 찾을 수 없습니다.')
    if (session.authType === 'key' && !isAbsolute(session.privateKeyPath)) throw new Error('개인키 경로는 절대 경로여야 합니다.')
    if (typeof connId !== 'string' || !UUID.test(connId) || ssh.has(connId) || local.has(connId)) throw new Error('잘못된 연결 ID입니다.')
    void ssh.connect(session, connId, isSize(cols) ? cols : 80, isSize(rows) ? rows : 24)
  })
  // 세션에 저장된 주소로만 연다 (renderer가 임의 명령을 넘기지 못함).
  ipcMain.handle('rdp:open', (_e, sessionId: unknown) => {
    const s = isId(sessionId) ? sessions.get(sessionId) : undefined
    if (!s || s.protocol !== 'rdp') throw new Error('RDP 세션을 찾을 수 없습니다.')
    if (process.platform !== 'win32') throw new Error('RDP는 지금은 Windows에서만 지원합니다.')
    spawn('mstsc.exe', [`/v:${s.host}:${s.port}`], { detached: true, stdio: 'ignore' }).unref()
  })
  ipcMain.handle('log:start', (_e, connId: unknown, name: unknown) => {
    if (isId(connId) && (ssh.has(connId) || local.has(connId))) return logs.start(connId, typeof name === 'string' ? name.slice(0, 80) : 'session')
  })
  ipcMain.on('log:stop', (_e, connId: unknown) => {
    if (isId(connId)) logs.stop(connId)
  })
  // 경로는 main이 만든 로그 파일만 연다.
  ipcMain.on('log:reveal', (_e, path: unknown) => {
    if (typeof path === 'string' && path.startsWith(join(app.getPath('documents'), 'Skiff Logs'))) shell.showItemInFolder(path)
  })
  const snippetsPath = join(dataDir, 'snippets.json')
  ipcMain.handle('snippets:list', () => readJson<{ version: 1; snippets: Snippet[] }>(snippetsPath, { version: 1, snippets: [] }).snippets)
  ipcMain.handle('snippets:save', (_e, list: unknown) => {
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')
    const snippets: Snippet[] = (Array.isArray(list) ? list : [])
      .slice(0, 200)
      .map((s) => ({ id: str(s?.id, 64) || randomUUID(), name: str(s?.name, 100).trim(), command: str(s?.command, 10000) }))
      .filter((s) => s.name && s.command)
    writeJson(snippetsPath, { version: 1, snippets })
    return snippets
  })
  ipcMain.handle('settings:get', () => settings.get())
  ipcMain.handle('settings:save', (_e, input: unknown) => settings.save(input))
  ipcMain.handle('local:profiles', () => local.list())
  ipcMain.handle('local:open', (_e, profileId: unknown, connId: unknown, cols: unknown, rows: unknown) => {
    if (typeof profileId !== 'string' || typeof connId !== 'string' || !UUID.test(connId) || ssh.has(connId) || local.has(connId))
      throw new Error('잘못된 요청입니다.')
    return local.open(connId, profileId, isSize(cols) ? cols : 80, isSize(rows) ? rows : 24)
  })
  ipcMain.on('ssh:write', (_e, connId: unknown, data: unknown) => {
    if (!isId(connId) || typeof data !== 'string') return
    if (local.has(connId)) local.write(connId, data)
    else ssh.write(connId, data)
  })
  ipcMain.on('ssh:resize', (_e, connId: unknown, cols: unknown, rows: unknown) => {
    if (!isId(connId) || !isSize(cols) || !isSize(rows)) return
    if (local.has(connId)) local.resize(connId, cols, rows)
    else ssh.resize(connId, cols, rows)
  })
  ipcMain.on('ssh:disconnect', (_e, connId: unknown) => {
    if (!isId(connId)) return
    if (local.has(connId)) local.kill(connId)
    else ssh.disconnect(connId)
  })

  ipcMain.handle('tunnels:start', (_e, connId: unknown, ruleId: unknown) => {
    if (isId(connId) && isId(ruleId)) return ssh.startTunnel(connId, ruleId)
  })
  ipcMain.on('tunnels:stop', (_e, connId: unknown, ruleId: unknown) => {
    if (isId(connId) && isId(ruleId)) ssh.stopTunnel(connId, ruleId)
  })
  ipcMain.handle('tunnels:states', (_e, connId: unknown) => (isId(connId) ? ssh.tunnelStates(connId) : {}))

  ipcMain.on('prompt:reply', (_e, id: unknown, reply: unknown) => {
    const pending = isId(id) ? pendingPrompts.get(id) : undefined
    if (!pending) return
    pendingPrompts.delete(id as string)
    pending.resolve(checkReply(pending.body, reply))
  })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: 'Skiff',
    icon: join(__dirname, '../../build/icon.png'),
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  // 외부 링크는 앱 안에서 열지 않는다.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.on('closed', () => {
    win = null
    for (const p of pendingPrompts.values()) p.resolve(null)
    pendingPrompts.clear()
    ssh.disconnectAll()
    local.killAll()
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

// macOS는 편집 메뉴가 있어야 입력칸 복사/붙여넣기 단축키가 동작한다.
// 설치본에서만 업데이트를 확인한다. 받으면 다음 실행 때 적용된다.
// ponytail: electron-updater 기본 알림으로 충분. 자체 업데이트 화면은 필요해지면.
function checkUpdates(): void {
  if (!app.isPackaged) return
  autoUpdater.checkForUpdatesAndNotify().catch(() => {})
}

Menu.setApplicationMenu(
  process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]) : null
)
app.whenReady().then(() => {
  registerIpc()
  createWindow()
  checkUpdates()
})
app.on('window-all-closed', () => app.quit())
