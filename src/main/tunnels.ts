import { connect, createServer, isIP, type Server, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { Client } from 'ssh2'
import type { TunnelRule } from '../shared/types'

const bridge = (a: Duplex, b: Duplex) => {
  a.pipe(b).pipe(a)
  for (const [x, y] of [[a, b], [b, a]]) {
    x.on('error', () => y.destroy())
    x.on('close', () => y.destroy())
  }
}

const listen = (server: Server, port: number) =>
  new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) =>
      reject(new Error(err.code === 'EADDRINUSE' ? `내 PC의 포트 ${port}이(가) 이미 사용 중입니다.` : err.message))
    )
    // 기본은 loopback. 다른 PC에 열 필요가 생기면 규칙에 바인드 주소를 추가한다.
    server.listen(port, '127.0.0.1', () => resolve())
  })

/** 최소 SOCKS5 (인증 없음, CONNECT만). */
// ponytail: 핸드셰이크 패킷이 TCP로 쪼개져 오면 실패한다. 로컬 loopback에서는 사실상 한 번에 온다.
function socks5(sock: Socket, open: (host: string, port: number) => Promise<Duplex>) {
  const fail = (code: number) => sock.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]))
  sock.once('data', (greet: Buffer) => {
    if (greet[0] !== 5) return sock.destroy()
    sock.write(Buffer.from([5, 0]))
    sock.once('data', (req: Buffer) => {
      if (req[0] !== 5 || req[1] !== 1) return fail(7)
      let host: string
      let at: number
      if (req[3] === 1) (host = [...req.subarray(4, 8)].join('.')), (at = 8)
      else if (req[3] === 3) (host = req.toString('utf8', 5, 5 + req[4])), (at = 5 + req[4])
      else if (req[3] === 4) (host = (req.subarray(4, 20).toString('hex').match(/.{4}/g) ?? []).join(':')), (at = 20)
      else return fail(8)
      open(host, req.readUInt16BE(at)).then(
        (ch) => {
          sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
          bridge(sock, ch)
        },
        () => fail(5)
      )
    })
  })
}

/** 한 SSH 연결의 터널들. 연결이 끝나면 stopAll로 listener를 모두 닫는다. */
export class Tunnels {
  private readonly servers = new Map<string, Server>()
  private readonly remote = new Map<number, TunnelRule>()

  constructor(private readonly client: Client) {
    client.on('tcp connection', (info, accept, reject) => {
      const rule = this.remote.get(info.destPort)
      if (!rule) return reject()
      bridge(accept(), connect(rule.destPort, rule.destHost))
    })
  }

  private forwardOut(host: string, port: number): Promise<Duplex> {
    return new Promise((resolve, reject) =>
      this.client.forwardOut('127.0.0.1', 0, host, port, (err, ch) => (err ? reject(err) : resolve(ch)))
    )
  }

  isRunning(ruleId: string): boolean {
    return this.servers.has(ruleId) || [...this.remote.values()].some((r) => r.id === ruleId)
  }

  async start(rule: TunnelRule): Promise<void> {
    if (this.isRunning(rule.id)) return
    if (rule.type === 'remote') {
      await new Promise<void>((resolve, reject) =>
        this.client.forwardIn('127.0.0.1', rule.bindPort, (err) =>
          err ? reject(new Error(`서버가 원격 포트 ${rule.bindPort} 포워딩을 거부했습니다. (포트 사용 중이거나 AllowTcpForwarding 설정 확인)`)) : resolve()
        )
      )
      this.remote.set(rule.bindPort, rule)
      return
    }
    const server = createServer((sock) => {
      sock.on('error', () => {})
      if (rule.type === 'dynamic') return socks5(sock, (h, p) => this.forwardOut(h, p))
      this.forwardOut(rule.destHost, rule.destPort).then(
        (ch) => bridge(sock, ch),
        () => sock.destroy()
      )
    })
    await listen(server, rule.bindPort)
    this.servers.set(rule.id, server)
  }

  stop(ruleId: string): void {
    const server = this.servers.get(ruleId)
    if (server) {
      server.close()
      this.servers.delete(ruleId)
    }
    for (const [port, rule] of this.remote) {
      if (rule.id !== ruleId) continue
      this.remote.delete(port)
      this.client.unforwardIn('127.0.0.1', port, () => {})
    }
  }

  stopAll(): void {
    for (const id of this.servers.keys()) this.stop(id)
    this.remote.clear()
  }
}

export const isHost = (h: string) => h.length > 0 && h.length <= 255 && (isIP(h) > 0 || /^[a-zA-Z0-9.-]+$/.test(h))
