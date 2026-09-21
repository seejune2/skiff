import { randomBytes } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { Duplex } from 'node:stream'
import { Client, utils, type ClientChannel, type ConnectConfig, type SFTPWrapper, type KeyboardInteractiveCallback, type Prompt } from 'ssh2'
import type { ConnState, ConnStatus, PromptBody, PromptReply, Session, TunnelStatus } from '../shared/types'
import { fingerprint, keyType, type KnownHosts } from './knownHosts'
import { Tunnels } from './tunnels'
import { bridgeX11 } from './x11'

export interface SshDeps {
  knownHosts: KnownHosts
  /** 사용자에게 묻는다. 취소하면 null. */
  prompt(connId: string, body: PromptBody): Promise<PromptReply>
  /** 비밀번호 저장소를 쓸 수 없으면 null을 돌려주고 save는 호출되지 않는다. */
  passwords: { canSave(sessionId: string): boolean; get(sessionId: string): string | null; save(sessionId: string, password: string): void }
  onData(connId: string, data: Uint8Array): void
  onStatus(status: ConnStatus): void
  onTunnel(status: TunnelStatus): void
  /** 점프 호스트로 쓸 저장된 세션을 찾는다. */
  resolveSession(sessionId: string): Session | undefined
  /** 로컬 X 서버 TCP 포트와, 서버를 준비하고 문제가 있으면 안내 문구를 돌려주는 함수 */
  x11: { port: number; prepare(): Promise<string | null> }
}

interface Failure {
  message: string
  retryable: boolean
}

interface Conn {
  client: Client
  stream?: ClientChannel
  /** 연결 종료 시 보여줄 원인. 첫 원인만 남긴다. */
  failure?: Failure
  /** 소켓을 열기 전(개인키 암호 입력 중)에 끊기를 눌렀는지 */
  ended?: boolean
  sftp?: Promise<SFTPWrapper>
  session: Session
  tunnels?: Tunnels
  /** 점프 호스트 연결. 본 연결이 끝나면 같이 닫는다. */
  jump?: Client
}

const MAX_PASSWORD_TRIES = 3
const MAX_KEY_SIZE = 64 * 1024

export class SshManager {
  private readonly conns = new Map<string, Conn>()

  constructor(private readonly deps: SshDeps) {}

  async connect(session: Session, connId: string, cols: number, rows: number): Promise<void> {
    const conn: Conn = { client: new Client(), session }
    this.conns.set(connId, conn)
    const status = (state: ConnState, message?: string, extra?: Partial<ConnStatus>) =>
      this.deps.onStatus({ connId, state, message, ...extra })
    const fail = (message: string) => {
      conn.failure ??= { message, retryable: false }
      conn.client.end()
    }
    status('connecting')

    let sock: Duplex | undefined
    if (session.jumpSessionId) {
      try {
        const jump = this.deps.resolveSession(session.jumpSessionId)
        if (!jump) throw new Error('점프 호스트 세션을 찾을 수 없습니다.')
        status('connecting', `점프 호스트 ${jump.username}@${jump.host} 접속 중`)
        conn.jump = await this.openJump(jump, connId)
        sock = await new Promise<Duplex>((resolve, reject) =>
          conn.jump!.forwardOut('127.0.0.1', 0, session.host, session.port, (err, ch) => (err ? reject(err) : resolve(ch)))
        )
      } catch (err) {
        conn.jump?.end()
        this.conns.delete(connId)
        return status('error', `점프 호스트: ${(err as Error).message}`, { retryable: true })
      }
    }

    const auth = await this.authConfig(session, connId, {
      setFailure: (f) => (conn.failure ??= f),
      cancel: (message) => fail(message),
      onAuthStart: () => status('authenticating')
    })
    if (!auth || conn.ended) {
      conn.jump?.end()
      this.conns.delete(connId)
      return status('closed', auth ? '연결이 종료되었습니다.' : '인증 입력을 취소했습니다.', { manual: true })
    }

    const { client } = conn
    const notice = (text: string) => this.deps.onData(connId, Buffer.from(`\x1b[33m[X11] ${text}\x1b[0m\r\n`))
    // 원격에는 가짜 쿠키를 주고, 들어오는 X11 연결에서 확인한 뒤 뗀다.
    const fakeCookie = randomBytes(16)
    client.on('x11', (_info, accept, reject) => {
      if (!session.x11) return reject()
      bridgeX11(accept(), fakeCookie, this.deps.x11.port)
    })
    const openShell = (x11: boolean, warning: string | null) => {
      const x11Options = x11 ? { x11: { protocol: 'MIT-MAGIC-COOKIE-1', cookie: fakeCookie, single: false, screen: 0 } } : {}
      client.shell({ term: 'xterm-256color', cols, rows }, x11Options, (err, stream) => {
        // X11 요청만 거부되면 X11 없이 터미널은 연다.
        if (err && x11) return openShell(false, '서버가 X11 포워딩을 거부했습니다. 서버의 /etc/ssh/sshd_config에 X11Forwarding yes가 있는지 확인하세요.')
        if (err) return fail(`셸을 열 수 없습니다: ${err.message}`)
        if (warning) notice(warning)
        conn.stream = stream
        stream.on('data', (d: Buffer) => this.deps.onData(connId, d))
        stream.stderr.on('data', (d: Buffer) => this.deps.onData(connId, d))
        stream.on('close', () => client.end())
        status('connected')
        conn.tunnels = new Tunnels(client)
        for (const rule of session.tunnels ?? []) if (rule.autoStart) void this.startTunnel(connId, rule.id)
      })
    }
    client.on('ready', async () => {
      auth.afterReady()
      openShell(!!session.x11, session.x11 ? await this.deps.x11.prepare() : null)
    })
    client.on('error', (err) => {
      conn.failure ??= describeError(err)
    })
    client.on('close', () => {
      conn.tunnels?.stopAll()
      conn.jump?.end()
      this.conns.delete(connId)
      if (conn.failure) status('error', conn.failure.message, { manual: conn.ended, retryable: conn.failure.retryable && !conn.ended })
      // 서버 쪽에서 끊긴 경우(로그아웃, 타임아웃)도 사용자가 끊은 게 아니면 다시 붙여 본다.
      else status('closed', '연결이 종료되었습니다.', { manual: conn.ended, retryable: !conn.ended })
    })

    client.connect({ ...auth.config, sock })
  }

  /** 점프 호스트에 먼저 붙는다. 실패하면 throw. */
  private async openJump(jump: Session, connId: string): Promise<Client> {
    const client = new Client()
    let failure: Failure | undefined
    const auth = await this.authConfig(jump, connId, {
      setFailure: (f) => (failure ??= f),
      cancel: (message) => {
        failure ??= { message, retryable: false }
        client.end()
      },
      onAuthStart: () => {}
    })
    if (!auth) throw new Error('인증 입력을 취소했습니다.')
    await new Promise<void>((resolve, reject) => {
      client.on('ready', () => {
        auth.afterReady()
        resolve()
      })
      client.on('error', (err) => (failure ??= describeError(err)))
      client.on('close', () => reject(new Error(failure?.message ?? '연결이 끊겼습니다.')))
      client.connect(auth.config)
    })
    return client
  }


  /**
   * 인증과 호스트 키 확인 설정을 만든다. 본 연결과 점프 호스트가 같이 쓴다.
   * 개인키 암호나 비밀번호 입력을 취소하면 null.
   */
  private async authConfig(
    session: Session,
    connId: string,
    handlers: { setFailure(f: Failure): void; cancel(message: string): void; onAuthStart(): void }
  ): Promise<{ config: ConnectConfig; afterReady(): void } | null> {
    let key: { data: Buffer; passphrase?: string } | undefined
    if (session.authType === 'key') {
      key = await this.loadKey(connId, session.privateKeyPath)
      if (!key) return null
    }

    const target = `${session.username}@${session.host}`
    const methods: string[] =
      session.authType === 'key'
        ? ['publickey', 'keyboard-interactive']
        : [...Array(MAX_PASSWORD_TRIES).fill('password'), 'keyboard-interactive']
    let passwordTries = 0
    let lastPassword: string | null = null
    let passwordToSave: string | null = null
    let kiUsedPassword = false

    const askPassword = async (): Promise<string | null> => {
      const saved = passwordTries === 0 ? this.deps.passwords.get(session.id) : null
      passwordTries++
      if (saved !== null) return saved
      const reply = await this.deps.prompt(connId, {
        kind: 'password',
        target,
        retry: passwordTries > 1,
        canSave: this.deps.passwords.canSave(session.id)
      })
      if (!isValue(reply)) return null
      passwordToSave = reply.save ? reply.value : null
      return reply.value
    }

    const keyboardInteractive = (
      name: string,
      instructions: string,
      _lang: string,
      prompts: Prompt[],
      finish: KeyboardInteractiveCallback
    ) => {
      // 비밀번호 방식에서 서버가 비밀번호 한 칸만 물으면 이미 입력한 비밀번호로 한 번 답한다.
      if (lastPassword !== null && !kiUsedPassword && prompts.length === 1 && !prompts[0].echo) {
        kiUsedPassword = true
        return finish([lastPassword])
      }
      if (prompts.length === 0) return finish([])
      this.deps
        .prompt(connId, {
          kind: 'keyboard-interactive',
          target,
          name,
          instructions,
          prompts: prompts.map((p) => ({ prompt: p.prompt, echo: !!p.echo }))
        })
        .then((reply) => {
          if (Array.isArray(reply) && reply.length === prompts.length) finish(reply)
          else handlers.cancel('인증을 취소했습니다.')
        })
    }

    return {
      afterReady: () => {
        if (passwordToSave !== null && lastPassword === passwordToSave) this.deps.passwords.save(session.id, passwordToSave)
      },
      config: {
        host: session.host,
        port: session.port,
        username: session.username,
        // 사용자가 호스트 키와 비밀번호를 확인하는 동안 끊기지 않도록 준비 시간 제한을 두지 않는다.
        readyTimeout: 0,
        // 30초 안에 끊긴 걸 알아챈다.
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        hostVerifier: (hostKey: Buffer, verify: (ok: boolean) => void) => {
          this.verifyHost(connId, session, hostKey).then(
            (ok) => {
              if (!ok) handlers.setFailure({ message: '호스트 키를 신뢰하지 않아 연결을 중단했습니다.', retryable: false })
              verify(ok)
            },
            () => verify(false)
          )
        },
        authHandler: (methodsLeft, _partial, next) => {
          let method: string | undefined
          while ((method = methods.shift())) {
            if (!methodsLeft || methodsLeft.includes(method as never)) break
          }
          if (!method) return next(false as never)
          handlers.onAuthStart()
          const username = session.username
          if (method === 'publickey') return next({ type: 'publickey', username, key: key!.data, passphrase: key!.passphrase })
          if (method === 'keyboard-interactive') return next({ type: 'keyboard-interactive', username, prompt: keyboardInteractive })
          askPassword().then((password) => {
            if (password === null) {
              handlers.setFailure({ message: '인증을 취소했습니다.', retryable: false })
              return next(false as never)
            }
            lastPassword = password
            next({ type: 'password', username, password })
          })
        }
      }
    }
  }

  /** 규칙 id는 연결된 세션의 저장된 규칙에서 찾는다 (renderer가 임의 규칙을 넘기지 못함). */
  async startTunnel(connId: string, ruleId: string): Promise<void> {
    const conn = this.conns.get(connId)
    const rule = conn?.session.tunnels?.find((r) => r.id === ruleId)
    if (!conn?.tunnels || !rule) throw new Error('연결되어 있지 않거나 규칙이 없습니다.')
    const report = (state: TunnelStatus['state'], message?: string) => this.deps.onTunnel({ connId, ruleId, state, message })
    try {
      await conn.tunnels.start(rule)
      report('running')
    } catch (err) {
      report('error', (err as Error).message)
    }
  }

  stopTunnel(connId: string, ruleId: string): void {
    this.conns.get(connId)?.tunnels?.stop(ruleId)
    this.deps.onTunnel({ connId, ruleId, state: 'stopped' })
  }

  tunnelStates(connId: string): Record<string, boolean> {
    const conn = this.conns.get(connId)
    return Object.fromEntries((conn?.session.tunnels ?? []).map((r) => [r.id, !!conn?.tunnels?.isRunning(r.id)]))
  }

  has(connId: string): boolean {
    return this.conns.has(connId)
  }

  /** 같은 SSH 연결 위에 SFTP 채널을 한 번 열어 재사용한다. */
  sftp(connId: string): Promise<SFTPWrapper> {
    const conn = this.conns.get(connId)
    if (!conn?.stream) return Promise.reject(new Error('연결되어 있지 않습니다.'))
    conn.sftp ??= checkQuietShell(conn.client)
      .then(
        () =>
          new Promise<SFTPWrapper>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('SFTP 서버가 응답하지 않습니다.')), 15000)
            conn.client.sftp((err, sftp) => {
              clearTimeout(timer)
              if (err) return reject(new Error(`SFTP를 열 수 없습니다: ${err.message}`))
              sftp.on('close', () => (conn.sftp = undefined))
              resolve(sftp)
            })
          })
      )
      .catch((err: Error) => {
        conn.sftp = undefined
        throw err
      })
    return conn.sftp
  }

  write(connId: string, data: string): void {
    this.conns.get(connId)?.stream?.write(data)
  }

  resize(connId: string, cols: number, rows: number): void {
    this.conns.get(connId)?.stream?.setWindow(rows, cols, 0, 0)
  }

  disconnect(connId: string): void {
    const conn = this.conns.get(connId)
    if (!conn) return
    conn.ended = true
    conn.client.end()
  }

  disconnectAll(): void {
    for (const connId of this.conns.keys()) this.disconnect(connId)
  }

  private async verifyHost(connId: string, session: Session, hostKey: Buffer): Promise<boolean> {
    const fp = fingerprint(hostKey)
    const type = keyType(hostKey)
    const known = this.deps.knownHosts.get(session.host, session.port)
    if (known?.fingerprint === fp) return true
    const reply = await this.deps.prompt(connId, {
      kind: 'hostkey',
      host: session.host,
      port: session.port,
      keyType: type,
      fingerprint: fp,
      previousFingerprint: known?.fingerprint
    })
    if (reply !== true) return false
    this.deps.knownHosts.set(session.host, session.port, { keyType: type, fingerprint: fp })
    return true
  }

  /** 암호가 걸린 키면 암호를 물어 확인한다. 취소하면 undefined. */
  private async loadKey(connId: string, path: string): Promise<{ data: Buffer; passphrase?: string } | undefined> {
    let data: Buffer
    try {
      if ((await stat(path)).size > MAX_KEY_SIZE) throw new Error()
      data = await readFile(path)
    } catch {
      throw new Error('개인키 파일을 읽을 수 없습니다.')
    }
    const parsed = utils.parseKey(data)
    if (!(parsed instanceof Error)) return { data }
    if (!/encrypted|passphrase/i.test(parsed.message)) throw new Error('지원하지 않는 개인키 형식입니다.')
    for (let retry = false; ; retry = true) {
      const reply = await this.deps.prompt(connId, { kind: 'passphrase', keyPath: path, retry })
      if (!isValue(reply)) return undefined
      if (!(utils.parseKey(data, reply.value) instanceof Error)) return { data, passphrase: reply.value }
    }
  }
}

/**
 * 비대화형 셸이 뭔가를 출력하면(.bashrc의 echo 등) SFTP 데이터가 깨지고, ssh2는 그 오류로 SSH 연결 전체를 끊는다.
 * SFTP를 열기 전에 `true`를 실행해 출력이 없는지 확인한다.
 */
function checkQuietShell(client: Client): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SFTP 준비 확인이 시간 초과되었습니다.')), 15000)
    client.exec('true', (err, stream) => {
      // SFTP 전용 계정은 exec를 막아 둔다. 그때는 확인 없이 SFTP를 연다.
      if (err) {
        clearTimeout(timer)
        return resolve()
      }
      let out = ''
      stream.on('data', (d: Buffer) => (out += d.toString('utf8')))
      stream.stderr.resume()
      stream.on('close', () => {
        clearTimeout(timer)
        if (!out) return resolve()
        reject(
          new Error(
            `서버 로그인 스크립트가 글자를 출력해서 SFTP를 쓸 수 없습니다 (출력: "${out.trim().slice(0, 60)}"). ` +
              '~/.bashrc 맨 위에 [[ $- != *i* ]] && return 을 넣거나 echo를 대화형 셸에서만 실행되게 하세요.'
          )
        )
      })
    })
  })
}

function isValue(reply: PromptReply): reply is { value: string; save?: boolean } {
  return typeof reply === 'object' && reply !== null && !Array.isArray(reply) && typeof reply.value === 'string'
}

/** 자동 재접속은 네트워크 문제로 끊긴 경우에만 한다. 인증 실패나 호스트 키 문제는 다시 시도해도 같은 결과다. */
function describeError(err: Error & { level?: string; code?: string }): Failure {
  if (err.level === 'client-authentication')
    return { message: '인증에 실패했습니다. 사용자명, 비밀번호 또는 키를 확인하세요.', retryable: false }
  if (err.level === 'client-timeout') return { message: '서버 응답 시간이 초과되었습니다.', retryable: true }
  switch (err.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return { message: '호스트를 찾을 수 없습니다.', retryable: true }
    case 'ECONNREFUSED':
      return { message: '연결이 거부되었습니다. 호스트와 포트를 확인하세요.', retryable: true }
    case 'ETIMEDOUT':
      return { message: '연결 시간이 초과되었습니다.', retryable: true }
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return { message: '호스트에 도달할 수 없습니다.', retryable: true }
    case 'ECONNRESET':
      return { message: '서버가 연결을 끊었습니다.', retryable: true }
  }
  return { message: `연결 오류: ${err.message}`, retryable: true }
}
