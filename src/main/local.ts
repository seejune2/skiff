import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { spawn, type IPty } from 'node-pty'
import type { ConnStatus, LocalProfile } from '../shared/types'

interface Profile extends LocalProfile {
  file: string
  args: string[]
}

const run = promisify(execFile)

/** 이 PC에서 열 수 있는 셸. renderer는 id만 넘기고 실행 파일은 여기서 정한다. */
async function detectProfiles(): Promise<Profile[]> {
  if (process.platform !== 'win32') {
    const shell = process.env.SHELL || '/bin/bash'
    return [{ id: 'shell', name: basename(shell), file: shell, args: ['-l'] }]
  }
  const list: Profile[] = [{ id: 'powershell', name: 'PowerShell', file: 'powershell.exe', args: ['-NoLogo'] }]
  if (await run('where.exe', ['pwsh.exe']).then(() => true, () => false))
    list.push({ id: 'pwsh', name: 'PowerShell 7', file: 'pwsh.exe', args: ['-NoLogo'] })
  list.push({ id: 'cmd', name: '명령 프롬프트', file: 'cmd.exe', args: [] })
  // wsl -l -q 는 UTF-16으로 출력한다.
  const distros = await run('wsl.exe', ['-l', '-q'], { encoding: 'utf16le' }).then(
    ({ stdout }) => stdout.split(/\r?\n/).map((s) => s.replace(/\0/g, '').trim()),
    () => []
  )
  for (const d of distros.filter((d) => d && !d.startsWith('docker-desktop')))
    list.push({ id: `wsl:${d}`, name: `WSL: ${d}`, file: 'wsl.exe', args: ['-d', d, '--cd', '~'] })
  return list
}

export class LocalShells {
  private readonly ptys = new Map<string, IPty>()
  private profiles?: Promise<Profile[]>

  constructor(
    private readonly onData: (connId: string, data: Uint8Array) => void,
    private readonly onStatus: (s: ConnStatus) => void
  ) {}

  list(): Promise<LocalProfile[]> {
    this.profiles ??= detectProfiles()
    return this.profiles.then((ps) => ps.map(({ id, name }) => ({ id, name })))
  }

  has(connId: string): boolean {
    return this.ptys.has(connId)
  }

  async open(connId: string, profileId: string, cols: number, rows: number): Promise<void> {
    const profile = (await (this.profiles ??= detectProfiles())).find((p) => p.id === profileId)
    if (!profile) throw new Error('알 수 없는 셸입니다.')
    const pty = spawn(profile.file, profile.args, { name: 'xterm-256color', cols, rows, cwd: homedir(), env: process.env })
    this.ptys.set(connId, pty)
    pty.onData((d) => this.onData(connId, Buffer.from(d, 'utf8')))
    pty.onExit(({ exitCode }) => {
      this.ptys.delete(connId)
      // 셸이 끝난 건 정상 종료다. 자동으로 다시 열지 않는다.
      this.onStatus({ connId, state: 'closed', message: `${profile.name} 종료 (코드 ${exitCode})`, manual: true })
    })
    this.onStatus({ connId, state: 'connected' })
  }

  write(connId: string, data: string): void {
    this.ptys.get(connId)?.write(data)
  }

  resize(connId: string, cols: number, rows: number): void {
    this.ptys.get(connId)?.resize(cols, rows)
  }

  kill(connId: string): void {
    this.ptys.get(connId)?.kill()
  }

  killAll(): void {
    for (const id of this.ptys.keys()) this.kill(id)
  }
}
