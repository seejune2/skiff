import type { SessionInput, TunnelRule } from '../../shared/types'

/** -L [127.0.0.1:]포트:호스트:포트, -R 포트:호스트:포트, -D 포트 */
function parseTunnel(flag: string, spec: string | undefined): TunnelRule | string {
  const parts = (spec ?? '').split(':')
  const id = crypto.randomUUID()
  if (flag === '-D') {
    const port = Number(parts.at(-1))
    return Number.isInteger(port) && port > 0 ? { id, type: 'dynamic', bindPort: port, destHost: '', destPort: 0, autoStart: true } : `-D 형식: -D 1080`
  }
  // 바인드 주소는 항상 127.0.0.1이라 앞에 붙은 주소는 무시한다.
  const [bind, host, port] = parts.slice(-3)
  if (parts.length < 3 || !Number(bind) || !host || !Number(port)) return `${flag} 형식: ${flag} 8080:localhost:80`
  return { id, type: flag === '-L' ? 'local' : 'remote', bindPort: Number(bind), destHost: host, destPort: Number(port), autoStart: true }
}

/** `ssh [-p 포트] [-X|-Y] [-i 키파일] [-l 사용자] [-L/-R/-D ...] [사용자@]호스트[:포트]`를 세션으로 바꾼다. 틀리면 한국어 오류 문구. */
export function parseSsh(line: string): SessionInput | string {
  const args = line.trim().split(/\s+/)
  if (args[0] !== 'ssh') return `알 수 없는 명령입니다: ${args[0]}`
  const s: SessionInput = { name: '', group: '', host: '', port: 22, username: '', authType: 'password', privateKeyPath: '', x11: false, tunnels: [] }
  for (let i = 1; i < args.length; i++) {
    const a = args[i]
    if (a === '-X' || a === '-Y') s.x11 = true
    else if (a === '-p') s.port = Number(args[++i])
    else if (a === '-l') s.username = args[++i] ?? ''
    else if (a === '-i') {
      s.authType = 'key'
      s.privateKeyPath = args[++i] ?? ''
    } else if (a === '-L' || a === '-R' || a === '-D') {
      const rule = parseTunnel(a, args[++i])
      if (typeof rule === 'string') return rule
      s.tunnels!.push(rule)
    } else if (a.startsWith('-')) return `지원하지 않는 옵션입니다: ${a}`
    else {
      const m = /^(?:([^@]+)@)?([^:@]+)(?::(\d+))?$/.exec(a)
      if (!m) return `주소 형식이 올바르지 않습니다: ${a}`
      if (m[1]) s.username = m[1]
      s.host = m[2]
      if (m[3]) s.port = Number(m[3])
    }
  }
  if (!s.host) return '사용법: ssh 사용자@호스트 [-p 포트] [-X]'
  if (!s.username) return '사용자명을 넣어주세요. 예: ssh root@10.0.1.111'
  return s
}
