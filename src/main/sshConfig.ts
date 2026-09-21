import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { SessionInput } from '../shared/types'

interface Parsed extends SessionInput {
  /** ProxyJump에 적힌 Host 이름. 나중에 세션 id로 바꾼다. */
  jumpHostName?: string
}

const expand = (p: string) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

/**
 * ~/.ssh/config에서 Host 블록을 읽는다. 와일드카드(`Host *`)와 모르는 항목은 건너뛴다.
 * Include, Match는 따라가지 않는다.
 */
// ponytail: 옵션 전체를 지원하지 않는다. HostName/User/Port/IdentityFile/ProxyJump만 쓴다.
export function parseSshConfig(text: string, group = 'ssh config'): Parsed[] {
  const out: Parsed[] = []
  let current: Parsed | undefined
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const [rawKey, ...rest] = line.split(/[\s=]+/)
    const key = rawKey.toLowerCase()
    const value = rest.join(' ').trim()
    if (key === 'host') {
      const names = rest.filter((n) => !n.includes('*') && !n.includes('?'))
      current = names[0]
        ? {
            name: names[0],
            group,
            host: names[0],
            port: 22,
            username: '',
            authType: 'password',
            privateKeyPath: '',
            x11: false,
            tunnels: []
          }
        : undefined
      if (current) out.push(current)
      continue
    }
    if (!current) continue
    if (key === 'hostname') current.host = value
    else if (key === 'user') current.username = value
    else if (key === 'port' && Number(value)) current.port = Number(value)
    else if (key === 'identityfile') {
      const path = expand(value.replace(/^"|"$/g, ''))
      if (isAbsolute(path)) {
        current.authType = 'key'
        current.privateKeyPath = path
      }
    } else if (key === 'forwardx11' || key === 'forwardx11trusted') current.x11 = /yes/i.test(value)
    else if (key === 'proxyjump' && value !== 'none') current.jumpHostName = value.split(',')[0].replace(/^.*@/, '').replace(/:\d+$/, '')
  }
  // 사용자명이 없으면 지금 PC 사용자명을 쓴다 (OpenSSH와 같은 동작)
  const me = process.env.USER || process.env.USERNAME || 'root'
  return out.filter((s) => s.host).map((s) => ({ ...s, username: s.username || me }))
}
