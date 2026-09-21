import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { connect as netConnect, createServer } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Server, utils, type Connection } from 'ssh2'
import type { ConnStatus, PromptBody, PromptReply, Session, TunnelRule, TunnelStatus } from '../src/shared/types'
import { KnownHosts } from '../src/main/knownHosts'
import { SessionStore } from '../src/main/sessions'
import { SshManager } from '../src/main/ssh'

const USER = 'tester'
const PASSWORD = '비밀-pass'
const clientKey = utils.generateKeyPairSync('ed25519', { passphrase: 'keypass', cipher: 'aes256-ctr', rounds: 16 })
const clientPub = utils.parseKey(clientKey.public)

interface TestServer {
  port: number
  sizes: { cols: number; rows: number }[]
  close(): void
}

/** 받은 입력을 그대로 돌려주는 셸을 가진 SSH 서버 */
function startServer(hostKey: string, x11?: 'reject' | ((open: (setup: Buffer) => void, cookieHex: string) => void)): Promise<TestServer> {
  const sizes: TestServer['sizes'] = []
  const server = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
    client.on('authentication', (ctx) => {
      if (ctx.username !== USER) return ctx.reject()
      if (ctx.method === 'password' && ctx.password === PASSWORD) return ctx.accept()
      if (ctx.method === 'publickey' && !(clientPub instanceof Error)) {
        const pub = clientPub as { getPublicSSH(): Buffer; verify(d: Buffer, s: Buffer, h?: string): boolean }
        if (!ctx.key.data.equals(pub.getPublicSSH())) return ctx.reject()
        if (!ctx.signature) return ctx.accept()
        if (pub.verify(ctx.blob!, ctx.signature, ctx.hashAlgo)) return ctx.accept()
      }
      ctx.reject(['password', 'publickey'])
    })
    // 터널 테스트용: direct-tcpip(로컬/다이내믹)은 실제로 연결하고, tcpip-forward(원격)는 받아서 기억한다.
    client.on('tcpip', (accept, _reject, info) => {
      const ch = accept()
      const sock = netConnect(info.destPort, info.destIP)
      ch.pipe(sock).pipe(ch)
    })
    client.on('request', (accept, reject, name, info) => {
      if (name !== 'tcpip-forward') return reject?.()
      accept?.()
      remoteForward = (data: Buffer) =>
        new Promise<string>((resolve) =>
          client.forwardOut((info as { bindAddr: string }).bindAddr, (info as { bindPort: number }).bindPort, '1.2.3.4', 1234, (err, ch) => {
            ch.on('data', (d: Buffer) => resolve(d.toString()))
            ch.write(data)
          })
        )
    })
    client.on('session', (accept) => {
      const session = accept()
      session.on('pty', (acc, _rej, info) => {
        sizes.push({ cols: info.cols, rows: info.rows })
        acc?.()
      })
      session.on('window-change', (acc, _rej, info) => {
        sizes.push({ cols: info.cols, rows: info.rows })
        acc?.()
      })
      session.on('x11', (acc, rej, info) => {
        if (x11 === 'reject' || !x11) return rej?.()
        acc?.()
        // 셸이 열린 뒤 원격 프로그램이 X11 연결을 여는 상황
        setTimeout(() => x11((setup) => client.x11('127.0.0.1', 5555, (err, ch) => !err && ch.write(setup)), String(info.cookie)), 50)
      })
      session.on('shell', (acc) => {
        const stream = acc()
        stream.write('ready\n')
        stream.on('data', (d: Buffer) => stream.write(d))
      })
    })
    client.on('error', () => {})
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: (server.address() as { port: number }).port, sizes, close: () => server.close() })
    )
  )
}

function makeManager(
  answers: (body: PromptBody) => PromptReply,
  savedPassword: string | null = null,
  x11Port = 6000,
  onTunnel: (s: TunnelStatus) => void = () => {}
) {
  const dir = mkdtempSync(join(tmpdir(), 'sshwb-'))
  const prompts: PromptBody[] = []
  const statuses: ConnStatus[] = []
  const saved: string[] = []
  let output = ''
  const manager = new SshManager({
    knownHosts: new KnownHosts(join(dir, 'known_hosts.json')),
    prompt: async (_id, body) => {
      prompts.push(body)
      return answers(body)
    },
    passwords: { canSave: () => true, get: () => savedPassword, save: (_id, pw) => saved.push(pw) },
    onData: (_id, d) => (output += Buffer.from(d).toString('utf8')),
    onStatus: (s) => statuses.push(s),
    onTunnel,
    x11: { port: x11Port, prepare: async () => null }
  })
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25))
    expect(check()).toBe(true)
  }
  return { manager, prompts, statuses, saved, dir, output: () => output, until }
}

const session = (port: number, extra: Partial<Session> = {}): Session => ({
  id: 's1',
  name: 'test',
  group: '',
  host: '127.0.0.1',
  port,
  username: USER,
  authType: 'password',
  privateKeyPath: '',
  ...extra
})

let remoteForward: ((data: Buffer) => Promise<string>) | undefined

const lastState = (statuses: ConnStatus[]) => statuses.at(-1)?.state

let servers: TestServer[] = []
afterEach(() => {
  servers.forEach((s) => s.close())
  servers = []
})

describe('SshManager', () => {
  it('비밀번호로 접속하고 한글 입출력과 창 크기 변경을 전달한다', async () => {
    const server = await startServer(utils.generateKeyPairSync('ed25519').private)
    servers.push(server)
    const t = makeManager((b) => (b.kind === 'hostkey' ? true : b.kind === 'password' ? { value: PASSWORD, save: true } : null))
    await t.manager.connect(session(server.port), 'c1', 100, 30)
    await t.until(() => lastState(t.statuses) === 'connected' && t.output().includes('ready'))
    expect(t.prompts.map((p) => p.kind)).toEqual(['hostkey', 'password'])
    expect(t.saved).toEqual([PASSWORD])

    t.manager.write('c1', '안녕하세요 ✓\n')
    await t.until(() => t.output().includes('안녕하세요 ✓'))

    t.manager.resize('c1', 120, 40)
    await t.until(() => server.sizes.some((s) => s.cols === 120 && s.rows === 40))
    expect(server.sizes[0]).toEqual({ cols: 100, rows: 30 })

    t.manager.disconnect('c1')
    await t.until(() => lastState(t.statuses) === 'closed')
  })

  it('저장된 호스트 키는 다시 묻지 않고, 바뀐 키는 이전 지문과 함께 묻고 거부하면 차단한다', async () => {
    const server = await startServer(utils.generateKeyPairSync('ed25519').private)
    servers.push(server)
    let acceptHost = true
    const t = makeManager((b) => (b.kind === 'hostkey' ? (acceptHost ? true : null) : null), PASSWORD)

    await t.manager.connect(session(server.port), 'c1', 80, 24)
    await t.until(() => lastState(t.statuses) === 'connected')
    t.manager.disconnect('c1')
    await t.until(() => lastState(t.statuses) === 'closed')

    await t.manager.connect(session(server.port), 'c2', 80, 24)
    await t.until(() => t.statuses.at(-1)?.connId === 'c2' && lastState(t.statuses) === 'connected')
    expect(t.prompts.filter((p) => p.kind === 'hostkey')).toHaveLength(1)
    t.manager.disconnect('c2')
    await t.until(() => lastState(t.statuses) === 'closed')
    server.close()

    // 호스트 키가 바뀐 상황: 저장된 지문과 다른 키를 가진 서버
    const server2 = await startServer(utils.generateKeyPairSync('ed25519').private)
    servers.push(server2)
    new KnownHosts(join(t.dir, 'known_hosts.json')).set('127.0.0.1', server2.port, { keyType: 'ssh-ed25519', fingerprint: 'SHA256:old' })
    acceptHost = false
    await t.manager.connect(session(server2.port), 'c3', 80, 24)
    await t.until(() => lastState(t.statuses) === 'error')
    const changed = t.prompts.at(-1)
    expect(changed).toMatchObject({ kind: 'hostkey', previousFingerprint: 'SHA256:old' })
    expect(t.statuses.at(-1)?.message).toContain('호스트 키')
  })

  it('잘못된 비밀번호는 다시 묻고, 취소하면 연결을 끝낸다', async () => {
    const server = await startServer(utils.generateKeyPairSync('ed25519').private)
    servers.push(server)
    let tries = 0
    const t = makeManager((b) => {
      if (b.kind === 'hostkey') return true
      if (b.kind === 'password') return ++tries < 3 ? { value: 'wrong' } : null
      return null
    })
    await t.manager.connect(session(server.port), 'c1', 80, 24)
    await t.until(() => lastState(t.statuses) === 'error')
    const pw = t.prompts.filter((p) => p.kind === 'password')
    expect(pw.map((p) => p.kind === 'password' && p.retry)).toEqual([false, true, true])
    expect(t.statuses.at(-1)?.message).toBe('인증을 취소했습니다.')
  })

  it('모든 비밀번호가 틀리면 인증 실패를 알린다', async () => {
    const server = await startServer(utils.generateKeyPairSync('ed25519').private)
    servers.push(server)
    const t = makeManager((b) => (b.kind === 'hostkey' ? true : b.kind === 'password' ? { value: 'wrong' } : null))
    await t.manager.connect(session(server.port), 'c1', 80, 24)
    await t.until(() => lastState(t.statuses) === 'error')
    expect(t.statuses.at(-1)?.message).toContain('인증에 실패')
  })

  it('암호 걸린 개인키로 접속한다', async () => {
    const server = await startServer(utils.generateKeyPairSync('ed25519').private)
    servers.push(server)
    let passTries = 0
    const t = makeManager((b) => {
      if (b.kind === 'hostkey') return true
      if (b.kind === 'passphrase') return { value: ++passTries === 1 ? 'bad' : 'keypass' }
      return null
    })
    const keyPath = join(t.dir, 'id_ed25519')
    writeFileSync(keyPath, clientKey.private)
    await t.manager.connect(session(server.port, { authType: 'key', privateKeyPath: keyPath }), 'c1', 80, 24)
    await t.until(() => lastState(t.statuses) === 'connected')
    expect(t.prompts.filter((p) => p.kind === 'passphrase').map((p) => p.kind === 'passphrase' && p.retry)).toEqual([false, true])
    t.manager.disconnect('c1')
  })

  it('접속할 수 없는 포트는 연결 거부로 표시한다', async () => {
    const t = makeManager(() => null)
    await t.manager.connect(session(1), 'c1', 80, 24)
    await t.until(() => lastState(t.statuses) === 'error')
    expect(t.statuses.at(-1)?.message).toContain('거부')
  })
})

describe('X11', () => {
  const setupPacket = (cookie: Buffer) => {
    const name = Buffer.from('MIT-MAGIC-COOKIE-1')
    const head = Buffer.alloc(12)
    head.write('l', 0, 'latin1')
    head.writeUInt16LE(11, 2)
    head.writeUInt16LE(name.length, 6)
    head.writeUInt16LE(cookie.length, 8)
    return Buffer.concat([head, name, Buffer.alloc(2), cookie, Buffer.from('REST')])
  }

  const fakeXServer = () =>
    new Promise<{ port: number; received: Buffer[]; close(): void }>((resolve) => {
      const received: Buffer[] = []
      const srv = createServer((s) => s.on('data', (d: Buffer) => received.push(d)))
      srv.listen(0, '127.0.0.1', () => resolve({ port: (srv.address() as { port: number }).port, received, close: () => srv.close() }))
    })

  it('가짜 쿠키가 맞으면 인증을 떼고 로컬 X 서버로 넘기고, 틀리면 막는다', async () => {
    const xs = await fakeXServer()
    let wrong = false
    const server = await startServer(utils.generateKeyPairSync('ed25519').private, (open, cookieHex) => {
      open(setupPacket(Buffer.from(cookieHex, 'hex')))
      wrong = true
      open(setupPacket(Buffer.alloc(16)))
    })
    servers.push(server)
    const t = makeManager((b) => (b.kind === 'hostkey' ? true : null), PASSWORD, xs.port)
    await t.manager.connect(session(server.port, { x11: true }), 'c1', 80, 24)
    await t.until(() => Buffer.concat(xs.received).length > 0)
    await new Promise((r) => setTimeout(r, 200))
    const got = Buffer.concat(xs.received)
    // 인증 길이 0인 12바이트 헤더 + 나머지. 틀린 쿠키 연결은 전달되지 않는다.
    expect(got.readUInt16LE(6)).toBe(0)
    expect(got.readUInt16LE(8)).toBe(0)
    expect(got.subarray(12).toString()).toBe('REST')
    expect(wrong).toBe(true)
    t.manager.disconnect('c1')
    xs.close()
  })

  it('서버가 X11을 거부해도 터미널은 열고 안내한다', async () => {
    const server = await startServer(utils.generateKeyPairSync('ed25519').private, 'reject')
    servers.push(server)
    const t = makeManager((b) => (b.kind === 'hostkey' ? true : null), PASSWORD)
    await t.manager.connect(session(server.port, { x11: true }), 'c1', 80, 24)
    await t.until(() => lastState(t.statuses) === 'connected' && t.output().includes('ready'))
    expect(t.output()).toContain('X11Forwarding')
    t.manager.disconnect('c1')
  })
})

describe('터널', () => {
  const echoServer = () =>
    new Promise<{ port: number; close(): void }>((resolve) => {
      const srv = createServer((s) => s.on('data', (d: Buffer) => s.write('echo:' + d.toString())))
      srv.listen(0, '127.0.0.1', () => resolve({ port: (srv.address() as { port: number }).port, close: () => srv.close() }))
    })
  const freePort = () =>
    new Promise<number>((resolve) => {
      const srv = createServer().listen(0, '127.0.0.1', () => {
        const port = (srv.address() as { port: number }).port
        srv.close(() => resolve(port))
      })
    })
  const request = (port: number, payload: Buffer, expectLen = 1) =>
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      const s = netConnect(port, '127.0.0.1', () => s.write(payload))
      s.on('data', (d: Buffer) => {
        chunks.push(d)
        if (Buffer.concat(chunks).length >= expectLen) (s.destroy(), resolve(Buffer.concat(chunks)))
      })
      s.on('error', reject)
    })

  it('local, remote, dynamic 터널이 실제 TCP를 전달하고, 사용 중인 포트는 오류로 알린다', async () => {
    const echo = await echoServer()
    const server = await startServer(utils.generateKeyPairSync('ed25519').private)
    servers.push(server)
    const [localPort, socksPort, remotePort] = [await freePort(), await freePort(), 40022]
    const tunnels: TunnelRule[] = [
      { id: 'L', type: 'local', bindPort: localPort, destHost: '127.0.0.1', destPort: echo.port, autoStart: true },
      { id: 'D', type: 'dynamic', bindPort: socksPort, destHost: '', destPort: 0, autoStart: false },
      { id: 'R', type: 'remote', bindPort: remotePort, destHost: '127.0.0.1', destPort: echo.port, autoStart: false },
      { id: 'BUSY', type: 'local', bindPort: localPort, destHost: '127.0.0.1', destPort: echo.port, autoStart: false }
    ]
    const events: TunnelStatus[] = []
    const t = makeManager((b) => (b.kind === 'hostkey' ? true : null), PASSWORD, 6000, (s) => events.push(s))
    await t.manager.connect(session(server.port, { tunnels }), 'c1', 80, 24)
    await t.until(() => events.some((e) => e.ruleId === 'L' && e.state === 'running'))

    expect((await request(localPort, Buffer.from('hi'), 7)).toString()).toBe('echo:hi')

    await t.manager.startTunnel('c1', 'D')
    const socks = await new Promise<string>((resolve) => {
      const s = netConnect(socksPort, '127.0.0.1', () => s.write(Buffer.from([5, 1, 0])))
      let step = 0
      s.on('data', (d: Buffer) => {
        if (step === 0) {
          step = 1
          const req = Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0, 0])
          req.writeUInt16BE(echo.port, 8)
          s.write(req)
        } else if (step === 1) {
          step = 2
          expect(d[1]).toBe(0)
          s.write('socks')
        } else (s.destroy(), resolve(d.toString()))
      })
    })
    expect(socks).toBe('echo:socks')

    await t.manager.startTunnel('c1', 'R')
    expect(events.find((e) => e.ruleId === 'R')?.state).toBe('running')
    expect(await remoteForward!(Buffer.from('back'))).toBe('echo:back')

    await t.manager.startTunnel('c1', 'BUSY')
    expect(events.find((e) => e.ruleId === 'BUSY')?.message).toContain('이미 사용 중')

    // 연결을 끊으면 로컬 포트를 돌려준다.
    t.manager.disconnect('c1')
    await t.until(() => lastState(t.statuses) === 'closed')
    await new Promise<void>((resolve, reject) => {
      const srv = createServer().once('error', reject).listen(localPort, '127.0.0.1', () => srv.close(() => resolve()))
    })
    echo.close()
  })
})

describe('SessionStore', () => {
  it('세션을 검증해 저장, 수정, 삭제한다', () => {
    const store = new SessionStore(join(mkdtempSync(join(tmpdir(), 'sshwb-')), 'sessions.json'))
    expect(() => store.save({ host: 'a b', port: 22, username: 'u' })).toThrow('호스트')
    expect(() => store.save({ host: 'h', port: 70000, username: 'u' })).toThrow('포트')
    expect(() => store.save({ host: 'h', port: 22, username: 'u', authType: 'key' })).toThrow('개인키')

    const s = store.save({ host: ' h ', port: '22', username: 'u', group: '운영' })
    expect(s).toMatchObject({ name: 'u@h', host: 'h', port: 22, group: '운영', authType: 'password' })
    store.save({ ...s, name: '서버' })
    expect(store.list()).toEqual([{ ...s, name: '서버' }])
    // 모르는 id는 새 세션으로 저장한다.
    expect(store.save({ ...s, id: 'forged' }).id).not.toBe('forged')
    store.delete(s.id)
    expect(store.list()).toHaveLength(1)
  })
})
