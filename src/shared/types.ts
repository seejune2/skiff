export type AuthType = 'password' | 'key'

export interface Session {
  id: string
  name: string
  group: string
  host: string
  port: number
  username: string
  authType: AuthType
  privateKeyPath: string
  /** 예전 세션에는 없다. */
  x11?: boolean
  /** 없으면 ssh. rdp는 Windows 원격 데스크톱(mstsc)으로 연다. */
  protocol?: 'ssh' | 'rdp'
  tunnels?: TunnelRule[]
  /** 이 세션에 들어갈 때 먼저 거칠 다른 저장된 세션의 id */
  jumpSessionId?: string
  /** + 탭에서 ssh 명령으로 연 임시 세션. 저장하지 않는다. */
  temp?: boolean
}

/** 새 세션은 id 없이 저장한다. */
export type SessionInput = Omit<Session, 'id'> & { id?: string }

/** local: 내 PC 포트 → 원격 목적지, remote: 원격 포트 → 내 PC 목적지, dynamic: 내 PC SOCKS5 프록시 */
export interface TunnelRule {
  id: string
  type: 'local' | 'remote' | 'dynamic'
  bindPort: number
  /** dynamic에서는 쓰지 않는다. */
  destHost: string
  destPort: number
  autoStart: boolean
}

export interface TunnelStatus {
  connId: string
  ruleId: string
  state: 'running' | 'stopped' | 'error'
  message?: string
}

/** 이 PC의 셸 (PowerShell, cmd, WSL 배포판) */
export interface LocalProfile {
  id: string
  name: string
}

export interface RemoteEdit {
  connId: string
  /** 원격 경로 */
  remote: string
  /** 임시 폴더의 로컬 경로. 닫을 때 이 값으로 지정한다. */
  local: string
  state: 'open' | 'uploading' | 'saved' | 'error' | 'closed'
  message?: string
}

export interface Snippet {
  id: string
  name: string
  command: string
}

export type ConnState = 'connecting' | 'authenticating' | 'connected' | 'closed' | 'error'

export interface ConnStatus {
  connId: string
  state: ConnState
  message?: string
  /** 사용자가 직접 끊었는지 (자동 재접속하지 않는다) */
  manual?: boolean
  /** 네트워크 문제처럼 다시 시도해 볼 만한 끊김인지 */
  retryable?: boolean
}

export type PromptBody =
  | { kind: 'hostkey'; host: string; port: number; keyType: string; fingerprint: string; previousFingerprint?: string }
  | { kind: 'password'; target: string; retry: boolean; canSave: boolean }
  | { kind: 'passphrase'; keyPath: string; retry: boolean }
  | { kind: 'keyboard-interactive'; target: string; name: string; instructions: string; prompts: { prompt: string; echo: boolean }[] }

export type PromptRequest = PromptBody & { id: string; connId: string }

/**
 * 프롬프트 종류별 응답. 취소는 null.
 * hostkey: true, password: { value, save }, passphrase: { value }, keyboard-interactive: string[]
 */
export type PromptReply = true | { value: string; save?: boolean } | string[] | null

export interface RemoteEntry {
  name: string
  type: 'dir' | 'file' | 'link'
  size: number
  /** 초 단위 유닉스 시간 */
  mtime: number
}

export interface Transfer {
  id: string
  connId: string
  direction: 'upload' | 'download'
  name: string
  done: number
  total: number
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  message?: string
}

export interface Settings {
  /** 터미널 글꼴 (쉼표로 여러 개) */
  fontFamily: string
  fontSize: number
  /** 터미널 색 조합 */
  terminalTheme: 'dark' | 'light' | 'solarized'
  /** 앱 화면 테마 */
  appTheme: 'light' | 'dark'
  /** 터미널이 기억하는 줄 수 */
  scrollback: number
  cursorStyle: 'block' | 'bar' | 'underline'
  cursorBlink: boolean
  /** Ctrl+V를 붙여넣기로 쓸지 (끄면 셸로 그대로 전달) */
  ctrlVPaste: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  fontFamily: '"Cascadia Mono", "D2Coding", Consolas, Menlo, "Malgun Gothic", monospace',
  fontSize: 14,
  terminalTheme: 'dark',
  appTheme: 'light',
  scrollback: 10000,
  cursorStyle: 'block',
  cursorBlink: true,
  ctrlVPaste: false
}
