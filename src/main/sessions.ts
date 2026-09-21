import { randomUUID } from 'node:crypto'
import type { Session, SessionInput, TunnelRule } from '../shared/types'
import { isHost } from './tunnels'
import { readJson, writeJson } from './jsonFile'

interface SessionFile {
  version: 1
  sessions: Session[]
}

const text = (v: unknown, max = 255): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** renderer에서 온 값을 다시 검증한다. 잘못된 값이면 한국어 메시지로 throw. */
const isPort = (p: unknown): p is number => Number.isInteger(p) && (p as number) >= 1 && (p as number) <= 65535

function validateTunnels(input: unknown): TunnelRule[] {
  if (!Array.isArray(input)) return []
  return input.slice(0, 50).map((raw): TunnelRule => {
    const t = (raw ?? {}) as Record<string, unknown>
    const type = t.type === 'remote' || t.type === 'dynamic' ? t.type : 'local'
    const bindPort = Number(t.bindPort)
    const destPort = Number(t.destPort)
    const destHost = text(t.destHost) || 'localhost'
    if (!isPort(bindPort)) throw new Error('터널 포트는 1~65535 사이여야 합니다.')
    if (type !== 'dynamic' && (!isPort(destPort) || !isHost(destHost))) throw new Error('터널 목적지 호스트와 포트를 확인하세요.')
    return {
      id: typeof t.id === 'string' && t.id.length <= 64 ? t.id : randomUUID(),
      type,
      bindPort,
      destHost: type === 'dynamic' ? '' : destHost,
      destPort: type === 'dynamic' ? 0 : destPort,
      autoStart: t.autoStart === true
    }
  })
}

export function validateSession(input: unknown): SessionInput {
  const o = (input ?? {}) as Record<string, unknown>
  const host = text(o.host)
  const username = text(o.username)
  const port = Number(o.port)
  const protocol = o.protocol === 'rdp' ? 'rdp' : 'ssh'
  const authType = o.authType === 'key' ? 'key' : 'password'
  const privateKeyPath = text(o.privateKeyPath, 1024)
  if (!host || /\s/.test(host)) throw new Error('호스트를 올바르게 입력하세요.')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('포트는 1~65535 사이여야 합니다.')
  if (!username && protocol === 'ssh') throw new Error('사용자명을 입력하세요.')
  if (protocol === 'ssh' && authType === 'key' && !privateKeyPath) throw new Error('개인키 파일을 선택하세요.')
  return {
    id: typeof o.id === 'string' ? o.id : undefined,
    protocol,
    name: text(o.name) || (username ? `${username}@${host}` : host),
    group: text(o.group),
    host,
    port,
    username,
    authType,
    privateKeyPath: authType === 'key' ? privateKeyPath : '',
    x11: o.x11 === true,
    tunnels: validateTunnels(o.tunnels),
    jumpSessionId: typeof o.jumpSessionId === 'string' && o.jumpSessionId !== o.id ? o.jumpSessionId : undefined
  }
}

export class SessionStore {
  constructor(private readonly path: string) {}

  list(): Session[] {
    return readJson<SessionFile>(this.path, { version: 1, sessions: [] }).sessions
  }

  get(id: string): Session | undefined {
    return this.list().find((s) => s.id === id)
  }

  save(input: unknown): Session {
    const valid = validateSession(input)
    const sessions = this.list()
    const index = sessions.findIndex((s) => s.id === valid.id)
    const session: Session = { ...valid, id: index >= 0 ? valid.id! : randomUUID() }
    if (index >= 0) sessions[index] = session
    else sessions.push(session)
    writeJson(this.path, { version: 1, sessions })
    return session
  }

  delete(id: string): void {
    writeJson(this.path, { version: 1, sessions: this.list().filter((s) => s.id !== id) })
  }
}
