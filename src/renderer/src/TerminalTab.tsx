import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import type { ConnState, Settings } from '../../shared/types'
import { TERMINAL_THEMES } from './SettingsDialog'
import { Highlighter } from './highlight'
import { parseSsh } from './quickConnect'
import type { SessionInput } from '../../shared/types'

interface Props {
  /** sessionId와 localProfile이 둘 다 null이면 ssh 명령을 받는 프롬프트 */
  sessionId: string | null
  /** 로컬 셸(PowerShell, WSL 등) 프로필 id */
  localProfile: string | null
  /** 출력 키워드 색칠. 자체 화면을 그리는 로컬 셸(claude, codex 등)에서는 끈다. */
  highlight: boolean
  /** 끊긴 뒤 Enter로 다시 연결할 수 있는지 (임시 세션은 프롬프트로 돌아간다) */
  reconnectable: boolean
  /** 실패하면 오류 문구 */
  onQuickConnect(input: SessionInput): Promise<string | null>
  /** 화면에 보이는지 */
  active: boolean
  /** 입력 포커스를 받을 창인지 (분할 보기에서는 둘 중 하나) */
  focused: boolean
  /** 분할 보기에서 창 위에 붙는 머리줄 (제목, 동시 입력 체크) */
  header?: ReactNode
  onFocus(): void
  /** 동시 입력: 이 탭에 친 키를 같이 보낼 다른 연결들 */
  broadcastTo: string[]
  settings: Settings
  /** 값이 바뀔 때마다 새로 연결한다. */
  attempt: number
  state: ConnState
  message?: string
  onConnId(connId: string): void
  onConnectError(message: string): void
  onReconnect(): void
}

const ended = (s: ConnState) => s === 'closed' || s === 'error'

export function TerminalTab({ sessionId, localProfile, highlight, reconnectable, onQuickConnect, active, focused, header, onFocus, broadcastTo, settings, attempt, state, message, onConnId, onConnectError, onReconnect }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal>(null)
  const fitRef = useRef<FitAddon>(null)
  const searchRef = useRef<SearchAddon>(null)
  const connIdRef = useRef<string | null>(null)
  const stateRef = useRef(state)
  const reconnectRef = useRef(onReconnect)
  reconnectRef.current = onReconnect
  const quickRef = useRef(onQuickConnect)
  quickRef.current = onQuickConnect
  const promptMode = sessionId === null && localProfile === null
  const localRef = useRef(promptMode)
  localRef.current = promptMode
  const highlightRef = useRef(highlight)
  const broadcastRef = useRef(broadcastTo)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  broadcastRef.current = broadcastTo
  highlightRef.current = highlight
  const lineRef = useRef('')
  const helpShownRef = useRef(false)
  // 로컬 프롬프트 명령 기록. pos === history.length 이면 새 줄을 입력 중.
  const historyRef = useRef<{ list: string[]; pos: number }>({ list: [], pos: 0 })
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    const term = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      scrollback: settings.scrollback,
      cursorBlink: settings.cursorBlink,
      cursorStyle: settings.cursorStyle,
      theme: TERMINAL_THEMES[settings.terminalTheme].theme
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.open(hostRef.current!)
    fit.fit()

    const copy = () => {
      if (!term.hasSelection()) return false
      void navigator.clipboard.writeText(term.getSelection())
      return true
    }
    const paste = () => navigator.clipboard.readText().then((t) => t && term.paste(t))
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey) return true
      // Ctrl+V 붙여넣기는 설정에서 켠 경우에만
      if (!e.shiftKey) {
        if (!settingsRef.current.ctrlVPaste || e.code !== 'KeyV') return true
        void paste()
        e.preventDefault()
        return false
      }
      if (e.code === 'KeyC') copy()
      else if (e.code === 'KeyV') void paste()
      else if (e.code === 'KeyF') setSearching(true)
      else return true
      e.preventDefault()
      return false
    })
    // MobaXterm처럼 드래그로 선택하면 바로 복사한다. Alt+드래그는 xterm.js의 사각형(열) 선택.
    term.onSelectionChange(() => {
      if (term.hasSelection()) void navigator.clipboard.writeText(term.getSelection())
    })
    // 오른쪽 클릭: 붙여넣기 (선택은 이미 복사되어 있음)
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      term.clearSelection()
      void paste()
    }
    hostRef.current!.addEventListener('contextmenu', onContextMenu)

    term.onData((data) => {
      if (localRef.current) return localInput(term, data)
      if (ended(stateRef.current)) {
        if (data === '\r') reconnectRef.current()
        return
      }
      if (connIdRef.current) window.api.ssh.write(connIdRef.current, data)
      for (const other of broadcastRef.current) window.api.ssh.write(other, data)
    })
    term.onResize(({ cols, rows }) => {
      if (connIdRef.current) window.api.ssh.resize(connIdRef.current, cols, rows)
    })
    let decoder = new TextDecoder()
    let highlighter = new Highlighter()
    let decodingFor: string | null = null
    const offData = window.api.ssh.onData((connId, data) => {
      if (connId !== connIdRef.current) return
      if (decodingFor !== connId) {
        decodingFor = connId
        decoder = new TextDecoder()
        highlighter = new Highlighter()
      }
      const text = decoder.decode(data, { stream: true })
      term.write(highlightRef.current ? highlighter.process(text) : text)
    })
    const observer = new ResizeObserver(() => {
      // 숨겨진 탭은 크기가 0이라 맞추지 않는다.
      if (hostRef.current?.offsetWidth) fit.fit()
    })
    observer.observe(hostRef.current!)

    termRef.current = term
    fitRef.current = fit
    searchRef.current = search
    const host = hostRef.current!
    return () => {
      offData()
      observer.disconnect()
      host.removeEventListener('contextmenu', onContextMenu)
      term.dispose()
    }
  }, [])

  // 로컬 프롬프트 한 줄 편집. 화살표 같은 이스케이프 입력은 무시한다.
  // ponytail: 명령 기록(↑)과 커서 이동 없음. 자주 쓰게 되면 추가.
  const localInput = (term: Terminal, data: string) => {
    const history = historyRef.current
    const replaceLine = (line: string) => {
      lineRef.current = line
      term.write('\r\x1b[K' + PROMPT + line)
    }
    if (data === '\x1b[A' || data === '\x1bOA') {
      if (history.pos > 0) replaceLine(history.list[--history.pos])
      return
    }
    if (data === '\x1b[B' || data === '\x1bOB') {
      if (history.pos < history.list.length) replaceLine(history.list[++history.pos] ?? '')
      return
    }
    if (data.startsWith('\x1b')) return
    for (const ch of data) {
      if (ch === '\r') {
        const line = lineRef.current.trim()
        lineRef.current = ''
        if (line && history.list.at(-1) !== line) history.list.push(line)
        history.pos = history.list.length
        term.write('\r\n')
        if (!line) term.write(PROMPT)
        else if (line === 'clear' || line === 'cls') term.write('\x1b[2J\x1b[H' + PROMPT)
        else if (line === 'help' || line === '도움말') term.write(HELP + PROMPT)
        else {
          const parsed = parseSsh(line)
          if (typeof parsed === 'string') term.write(`\x1b[31m${parsed}\x1b[0m\r\n${PROMPT}`)
          else void quickRef.current(parsed).then((err) => err && term.write(`\x1b[31m${err}\x1b[0m\r\n${PROMPT}`))
        }
      } else if (ch === '\x7f' || ch === '\b') {
        lineRef.current = [...lineRef.current].slice(0, -1).join('')
        term.write('\r\x1b[K' + PROMPT + lineRef.current)
      } else if (ch === '\x03') {
        lineRef.current = ''
        term.write('^C\r\n' + PROMPT)
      } else if (ch >= ' ') {
        lineRef.current += ch
        term.write(ch)
      }
    }
  }

  useEffect(() => {
    if (promptMode) return
    const term = termRef.current!
    const connId = crypto.randomUUID()
    connIdRef.current = connId
    stateRef.current = 'connecting'
    onConnId(connId)
    if (attempt > 0) term.write('\r\n\x1b[90m--- 다시 연결합니다 ---\x1b[0m\r\n')
    const opened = localProfile
      ? window.api.local.open(localProfile, connId, term.cols, term.rows)
      : window.api.ssh.connect(sessionId!, connId, term.cols, term.rows)
    opened.catch((err: Error) => onConnectError(cleanError(err)))
    // onConnId와 onConnectError는 attempt가 바뀔 때만 다시 쓰면 된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, sessionId, localProfile])

  useEffect(() => {
    stateRef.current = state
    if (ended(state) && connIdRef.current) {
      termRef.current?.write(
        `\r\n\x1b[33m[${message ?? '연결이 종료되었습니다.'}]\x1b[0m\r\n` +
          (reconnectable ? '\x1b[90mEnter 키를 누르면 다시 연결합니다.\x1b[0m\r\n' : '')
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, message])

  useEffect(() => {
    if (!promptMode) return
    connIdRef.current = null
    lineRef.current = ''
    termRef.current?.write((helpShownRef.current ? '' : HELP) + PROMPT)
    helpShownRef.current = true
  }, [promptMode])

  // 설정이 바뀌면 이미 열려 있는 터미널에도 바로 반영한다.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = settings.fontFamily
    term.options.fontSize = settings.fontSize
    term.options.scrollback = settings.scrollback
    term.options.cursorBlink = settings.cursorBlink
    term.options.cursorStyle = settings.cursorStyle
    term.options.theme = TERMINAL_THEMES[settings.terminalTheme].theme
    fitRef.current?.fit()
  }, [settings])

  useEffect(() => {
    if (active) fitRef.current?.fit()
    if (focused) termRef.current?.focus()
  }, [active, focused])

  const find = (backward: boolean) => {
    if (!query) return
    if (backward) searchRef.current?.findPrevious(query)
    else searchRef.current?.findNext(query)
  }

  return (
    <div
      className={`terminal-tab ${focused ? 'focused' : ''}`}
      style={{ display: active ? 'flex' : 'none' }}
      onMouseDown={onFocus}
    >
      {header}
      {searching && (
        <div className="terminal-search">
          <input
            autoFocus
            placeholder="터미널에서 찾기"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') find(e.shiftKey)
              if (e.key === 'Escape') {
                setSearching(false)
                searchRef.current?.clearDecorations()
                termRef.current?.focus()
              }
            }}
          />
          <button onClick={() => find(true)} title="이전 (Shift+Enter)">↑</button>
          <button onClick={() => find(false)} title="다음 (Enter)">↓</button>
          <button
            onClick={() => {
              setSearching(false)
              termRef.current?.focus()
            }}
            title="닫기 (Esc)"
          >
            ✕
          </button>
        </div>
      )}
      <div className="terminal-host" ref={hostRef} />
    </div>
  )
}

const PROMPT = '\x1b[36m로컬\x1b[0m> '
const HELP =
  '\x1b[90mssh 명령으로 접속합니다. 예: ssh root@10.0.1.111   ssh -p 2222 -X user@host   ssh -i ~/.ssh/id_ed25519 user@host\x1b[0m\r\n'

/** ipcRenderer.invoke 오류의 "Error invoking remote method ..." 접두어를 뗀다. */
export function cleanError(err: Error): string {
  return err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
