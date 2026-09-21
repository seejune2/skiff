import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_SETTINGS, type ConnState, type LocalProfile, type Settings, type Snippet, type PromptReply, type PromptRequest, type Session, type SessionInput } from '../../shared/types'
import { PromptDialog } from './PromptDialog'
import { SessionEditor } from './SessionEditor'
import { SettingsDialog } from './SettingsDialog'
import { SftpPanel } from './SftpPanel'
import { SnippetEditor } from './SnippetEditor'
import { TunnelPanel } from './TunnelPanel'
import { Sidebar } from './Sidebar'
import { cleanError, TerminalTab } from './TerminalTab'

interface Tab {
  id: string
  /** null이면 ssh 명령을 받는 로컬 프롬프트 탭 */
  session: Session | null
  /** 로컬 셸 탭 */
  local?: LocalProfile
  /** 세션 로그 파일. 연결이 끝나면 main이 닫으므로 같이 지운다. */
  logPath?: string
  /** 네트워크 문제로 끊겨서 자동 재접속 대상인지 */
  retryable?: boolean
  /** 자동 재접속 시도 횟수 */
  retries: number
  connId: string | null
  attempt: number
  state: ConnState
  message?: string
}

// 창 배치는 이 PC에서만 기억하면 되므로 localStorage에 둔다.
const load = <T,>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '') as T
  } catch {
    return fallback
  }
}
const store = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {}
}

const MAX_PANES = 8
/** 자동 재접속 간격(초). 마지막 값에서 멈춘다. */
const RETRY_DELAYS = [2, 5, 10, 20, 30]

const STATE_LABEL: Record<ConnState, string> = {
  connecting: '연결 중',
  authenticating: '인증 중',
  connected: '연결됨',
  closed: '연결 끊김',
  error: '오류'
}

export function App() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  /** 분할 보기: 좌우에 보이는 두 탭. activeTabId는 그중 입력을 받는 쪽. */
  /** 분할 보기: 열린 탭을 모두 격자로 보여준다. activeTabId는 입력을 받는 창. */
  const [split, setSplit] = useState(false)
  const [broadcast, setBroadcast] = useState(false)
  /** 동시 입력에서 뺀 탭. 새 탭은 기본으로 포함된다. */
  const [broadcastOff, setBroadcastOff] = useState<Set<string>>(new Set())
  const toggleBroadcastFor = (id: string) =>
    setBroadcastOff((old) => {
      const next = new Set(old)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [showSettings, setShowSettings] = useState(false)
  useEffect(() => void window.api.settings.get().then(setSettings), [])
  useEffect(() => {
    document.documentElement.dataset.theme = settings.appTheme
  }, [settings.appTheme])
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [sessionMenu, setSessionMenu] = useState<{ x: number; y: number } | null>(null)
  const [snippetMenu, setSnippetMenu] = useState<{ x: number; y: number } | null>(null)
  const [editingSnippets, setEditingSnippets] = useState(false)
  useEffect(() => void window.api.snippets.list().then(setSnippets), [])
  const [editing, setEditing] = useState<Session | 'new' | null>(null)
  const [prompts, setPrompts] = useState<PromptRequest[]>([])
  const [sidebarWidth, setSidebarWidth] = useState(() => load('sidebarWidth', 250))
  const [compact, setCompact] = useState(() => load('sidebarCompact', false))
  const [sidebarHidden, setSidebarHidden] = useState(() => load('sidebarHidden', false))
  const [sftpOpen, setSftpOpen] = useState(() => load('sftpOpen', true))
  const [profiles, setProfiles] = useState<LocalProfile[]>([])
  // 탭 바는 가로 스크롤이라 메뉴를 화면 좌표(fixed)로 띄운다.
  const [newMenu, setNewMenu] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => void window.api.local.profiles().then(setProfiles), [])
  const [rightTab, setRightTab] = useState<'files' | 'tunnels'>('files')
  useEffect(() => store('sftpOpen', sftpOpen), [sftpOpen])
  useEffect(() => store('sidebarWidth', sidebarWidth), [sidebarWidth])
  useEffect(() => store('sidebarCompact', compact), [compact])
  useEffect(() => store('sidebarHidden', sidebarHidden), [sidebarHidden])

  const startResize = (e: React.PointerEvent) => {
    const startX = e.clientX
    const startWidth = sidebarWidth
    // VS Code처럼 너무 좁게 끌면 접는다.
    const move = (ev: PointerEvent) => {
      const w = startWidth + ev.clientX - startX
      setSidebarHidden(w < 100)
      setSidebarWidth(Math.min(500, Math.max(160, w)))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    document.body.classList.add('resizing')
  }

  const reload = useCallback(() => window.api.sessions.list().then(setSessions), [])
  useEffect(() => void reload(), [reload])

  const updateTab = useCallback((id: string, patch: Partial<Tab>) => {
    setTabs((old) => old.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }, [])

  useEffect(() => {
    const offStatus = window.api.ssh.onStatus((s) =>
      setTabs((old) =>
        old.map((t) => {
          if (t.connId !== s.connId) return t
          // 임시 세션은 끝나면 로컬 프롬프트로 돌아간다.
          const back = t.session?.temp && (s.state === 'closed' || s.state === 'error')
          const ended = s.state === 'closed' || s.state === 'error'
          return {
            ...t,
            state: s.state,
            message: s.message,
            session: back ? null : t.session,
            logPath: ended ? undefined : t.logPath,
            retryable: ended ? !!s.retryable && !s.manual : false,
            retries: s.state === 'connected' ? 0 : t.retries
          }
        })
      )
    )
    const offPrompt = window.api.prompts.onRequest((req) => setPrompts((old) => [...old, req]))
    return () => {
      offStatus()
      offPrompt()
    }
  }, [])

  const openTab = (session: Session) => {
    if (session.protocol === 'rdp') {
      window.api.rdp.open(session.id).catch((err: Error) => window.alert(cleanError(err)))
      return
    }
    const id = crypto.randomUUID()
    setTabs((old) => [...old, { id, session, connId: null, attempt: 0, retries: 0, state: 'connecting' }])
    setActiveTabId(id)
  }

  const openShell = (local: LocalProfile) => {
    const id = crypto.randomUUID()
    setTabs((old) => [...old, { id, session: null, local, connId: null, attempt: 0, retries: 0, state: 'connecting' }])
    setActiveTabId(id)
  }

  const openLocalTab = () => {
    const id = crypto.randomUUID()
    setTabs((old) => [...old, { id, session: null, connId: null, attempt: 0, retries: 0, state: 'closed' }])
    setActiveTabId(id)
  }

  /** 실패하면 터미널에 보여줄 문구를 돌려준다. */
  const quickConnect = async (tab: Tab, input: SessionInput): Promise<string | null> => {
    try {
      const session = await window.api.sessions.temp(input)
      updateTab(tab.id, { session, state: 'connecting', message: undefined })
      return null
    } catch (err) {
      return cleanError(err as Error)
    }
  }

  // 자동 재접속 타이머. 사용자가 끊거나 탭을 닫으면 취소한다.
  const retryTimers = useRef(new Map<string, number>())
  const cancelRetry = (id: string) => {
    const timer = retryTimers.current.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      retryTimers.current.delete(id)
    }
  }

  useEffect(() => {
    for (const t of tabs) {
      const ended = t.state === 'closed' || t.state === 'error'
      if (!ended || !t.retryable || !t.session || t.session.temp) continue
      if (retryTimers.current.has(t.id) || t.retries >= RETRY_DELAYS.length) continue
      const wait = RETRY_DELAYS[t.retries]
      retryTimers.current.set(
        t.id,
        window.setTimeout(() => {
          retryTimers.current.delete(t.id)
          setTabs((old) =>
            old.map((x) =>
              x.id === t.id
                ? { ...x, attempt: x.attempt + 1, retries: x.retries + 1, state: 'connecting', message: undefined, retryable: false }
                : x
            )
          )
        }, wait * 1000)
      )
      updateTab(t.id, { message: `${t.message ?? '연결이 끊겼습니다.'} ${wait}초 뒤에 다시 연결합니다 (${t.retries + 1}/${RETRY_DELAYS.length})` })
    }
    // 더 이상 필요 없는 타이머 정리
    for (const id of retryTimers.current.keys()) if (!tabs.some((t) => t.id === id)) cancelRetry(id)
  }, [tabs, updateTab])

  const reconnect = (tab: Tab) => {
    cancelRetry(tab.id)
    if (!tab.session && !tab.local) return
    if (tab.connId && tab.state !== 'closed' && tab.state !== 'error') window.api.ssh.disconnect(tab.connId)
    updateTab(tab.id, { attempt: tab.attempt + 1, retries: 0, state: 'connecting', message: undefined, retryable: false })
  }

  const closeTab = (tab: Tab) => {
    cancelRetry(tab.id)
    if (tab.connId) window.api.ssh.disconnect(tab.connId)
    const rest = tabs.filter((t) => t.id !== tab.id)
    setTabs(rest)
    if (activeTabId === tab.id) setActiveTabId(rest.at(-1)?.id ?? null)
    if (rest.length < 2) setSplit(false)
  }

  const deleteSession = async (s: Session) => {
    if (!window.confirm(`"${s.name}" 세션을 삭제할까요?`)) return
    await window.api.sessions.delete(s.id)
    await reload()
  }

  const answerPrompt = (reply: PromptReply) => {
    const [first, ...rest] = prompts
    window.api.prompts.reply(first.id, reply)
    setPrompts(rest)
  }

  const selectTab = (id: string) => setActiveTabId(id)
  /** 분할에 띄울 탭. 한 화면에 최대 8칸. 지금 탭이 항상 들어간다. */
  const splitTabs = (() => {
    if (!split) return []
    if (tabs.length <= MAX_PANES) return tabs
    const head = tabs.filter((t) => t.id !== activeTabId).slice(0, MAX_PANES - 1)
    const active = tabs.find((t) => t.id === activeTabId)
    return active ? [...head, active].sort((a, b) => tabs.indexOf(a) - tabs.indexOf(b)) : head
  })()
  // 2칸은 좌우, 3~4칸은 2열, 5~6칸은 3열, 7~8칸은 4열
  const gridCols = splitTabs.length <= 2 ? splitTabs.length : splitTabs.length <= 4 ? 2 : splitTabs.length <= 6 ? 3 : 4

  const activeTab = tabs.find((t) => t.id === activeTabId)

  /** 줄마다 Enter를 붙여 보낸다. 동시 입력이 켜져 있으면 연결된 모든 탭에. */
  const runSnippet = (s: Snippet) => {
    const text = s.command.replace(/\r?\n/g, '\r').replace(/\r?$/, '\r')
    const targets = broadcast ? liveConns : activeTab?.connId ? [activeTab.connId] : []
    for (const c of targets) window.api.ssh.write(c, text)
  }
  const selected = sessions.find((s) => s.id === selectedId)
  const groups = useMemo(() => [...new Set(sessions.map((s) => s.group).filter(Boolean))].sort(), [sessions])
  // 동시 입력 대상: 연결된 SSH·로컬 셸 탭 전부
  const liveConns = tabs
    .filter((t) => (t.session || t.local) && t.state === 'connected' && t.connId && !broadcastOff.has(t.id))
    .map((t) => t.connId!)
  const broadcastBox = (t: Tab) =>
    broadcast && (t.session || t.local) ? (
      <label className="bc-check" title="동시 입력에 포함" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={!broadcastOff.has(t.id)} onChange={() => toggleBroadcastFor(t.id)} />
      </label>
    ) : null
  const liveConnId = activeTab?.session && activeTab.state === 'connected' ? activeTab.connId : null
  const live = (t?: Tab) => !!t && t.state !== 'closed' && t.state !== 'error'

  return (
    <div className="app">
      <header className="toolbar">
        <button className="icon" title={sidebarHidden ? '세션 목록 펼치기' : '세션 목록 접기'} onClick={() => setSidebarHidden(!sidebarHidden)}>
          ☰
        </button>
        <span className="brand">Skiff</span>
        <button onClick={() => setEditing('new')}>＋ 새 세션</button>
        <button
          title="세션 가져오기·내보내기"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setSessionMenu(sessionMenu ? null : { x: r.left, y: r.bottom })
          }}
        >
          ⋯
        </button>
        {sessionMenu && (
          <>
            <div className="menu-backdrop" onClick={() => setSessionMenu(null)} />
            <div className="menu" style={{ left: sessionMenu.x, top: sessionMenu.y }}>
              <button
                onClick={async () => {
                  setSessionMenu(null)
                  const n = await window.api.sessions.importSshConfig()
                  await reload()
                  if (n) window.alert(`SSH config에서 세션 ${n}개를 가져왔습니다.`)
                }}
              >
                ~/.ssh/config 가져오기
              </button>
              <button
                onClick={async () => {
                  setSessionMenu(null)
                  const n = await window.api.sessions.importFile()
                  await reload()
                  if (n) window.alert(`세션 ${n}개를 가져왔습니다.`)
                }}
              >
                파일에서 가져오기
              </button>
              <button
                onClick={async () => {
                  setSessionMenu(null)
                  const n = await window.api.sessions.exportAll()
                  if (n) window.alert(`세션 ${n}개를 내보냈습니다. 비밀번호는 포함되지 않습니다.`)
                }}
              >
                파일로 내보내기 (비밀번호 제외)
              </button>
            </div>
          </>
        )}
        <button disabled={!selected} onClick={() => selected && openTab(selected)}>
          ▶ 연결
        </button>
        <span className="sep" />
        <button disabled={!activeTab?.session && !activeTab?.local} onClick={() => activeTab && reconnect(activeTab)}>
          ↻ 재접속
        </button>
        <button
          disabled={!activeTab || (!live(activeTab) && !retryTimers.current.has(activeTab.id))}
          onClick={() => {
            if (!activeTab) return
            cancelRetry(activeTab.id)
            updateTab(activeTab.id, { retryable: false, retries: RETRY_DELAYS.length })
            if (activeTab.connId) window.api.ssh.disconnect(activeTab.connId)
          }}
        >
          ■ 연결 끊기
        </button>
        <span className="sep" />
        <button title="설정" onClick={() => setShowSettings(true)}>
          ⚙ 설정
        </button>
        <button
          className={activeTab?.logPath ? 'on danger-on' : ''}
          disabled={!activeTab?.connId || !live(activeTab)}
          title="이 탭의 출력을 문서\Skiff Logs 폴더에 저장"
          onClick={async () => {
            const t = activeTab!
            if (t.logPath) {
              window.api.logs.stop(t.connId!)
              updateTab(t.id, { logPath: undefined })
            } else {
              const path = await window.api.logs.start(t.connId!, t.session?.name ?? t.local?.name ?? 'session')
              if (path) updateTab(t.id, { logPath: path })
            }
          }}
        >
          ● 로그{activeTab?.logPath && ' 기록 중'}
        </button>
        <button
          title="자주 쓰는 명령 보내기"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setSnippetMenu(snippetMenu ? null : { x: r.left, y: r.bottom })
          }}
        >
          ⌘ 스니펫
        </button>
        {snippetMenu && (
          <>
            <div className="menu-backdrop" onClick={() => setSnippetMenu(null)} />
            <div className="menu" style={{ left: snippetMenu.x, top: snippetMenu.y }}>
              {snippets.map((s) => (
                <button
                  key={s.id}
                  disabled={!activeTab?.connId || !live(activeTab) || (!activeTab.session && !activeTab.local)}
                  title={s.command}
                  onClick={() => {
                    setSnippetMenu(null)
                    runSnippet(s)
                  }}
                >
                  {s.name}
                </button>
              ))}
              {snippets.length > 0 && <hr />}
              <button onClick={() => (setSnippetMenu(null), setEditingSnippets(true))}>스니펫 관리…</button>
            </div>
          </>
        )}
        <button
          className={broadcast ? 'on danger-on' : ''}
          title="입력한 키를 연결된 모든 탭에 동시에 보냄"
          onClick={() => setBroadcast(!broadcast)}
        >
          ⇉ 동시 입력{broadcast && ` (${liveConns.length})`}
        </button>
        <button
          className={split ? 'on' : ''}
          disabled={tabs.length < 2}
          title={`열린 탭을 한 화면에 나눠서 보기 (최대 ${MAX_PANES}칸)`}
          onClick={() => setSplit(!split)}
        >
          ◫ 분할{split && ` ${splitTabs.length}칸`}
        </button>
        <button className={sftpOpen ? 'on' : ''} title="파일(SFTP)·터널 패널 열기/닫기" onClick={() => setSftpOpen(!sftpOpen)}>
          📁 파일·터널
        </button>
      </header>

      <div className="body">
        {sidebarHidden ? (
          <button className="sidebar-rail" title="세션 목록 펼치기" onClick={() => setSidebarHidden(false)}>
            »
          </button>
        ) : (
          <>
            <Sidebar
              width={sidebarWidth}
              compact={compact}
              onToggleCompact={() => setCompact(!compact)}
              onHide={() => setSidebarHidden(true)}
              sessions={sessions}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onConnect={openTab}
              onEdit={setEditing}
              onDelete={deleteSession}
              onDuplicate={async (s) => {
                const { id: _id, ...rest } = s
                await window.api.sessions.save({ ...rest, name: `${s.name} (복사)` })
                await reload()
              }}
              onMove={async (s, group) => {
                await window.api.sessions.save({ ...s, group })
                await reload()
              }}
            />
            <div className="resizer" onPointerDown={startResize} onDoubleClick={() => setSidebarWidth(250)} title="드래그하여 크기 조절 (더블클릭: 기본 크기)" />
          </>
        )}

        <main className="workspace">
          <nav className="tabs">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={`tab ${t.id === activeTabId ? 'active' : ''}`}
                onClick={() => selectTab(t.id)}
                onAuxClick={(e) => e.button === 1 && closeTab(t)}
                title={t.session ? `${t.session.username}@${t.session.host}:${t.session.port}` : '로컬 프롬프트'}
              >
                {broadcastBox(t)}
                <span className={`dot ${t.state}`} />
                <span className="tab-title">{t.session?.name ?? t.local?.name ?? '새 탭'}</span>
                <button className="tab-close" title="탭 닫기" onClick={(e) => (e.stopPropagation(), closeTab(t))}>
                  ✕
                </button>
              </div>
            ))}
            <div className="tab-new-wrap">
              <button
                className="tab-new"
                title="새 탭"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect()
                  setNewMenu(newMenu ? null : { x: r.left, y: r.bottom })
                }}
              >
                ＋
              </button>
              {newMenu && (
                <>
                  <div className="menu-backdrop" onClick={() => setNewMenu(null)} />
                  <div className="menu" style={{ left: newMenu.x, top: newMenu.y }}>
                    {profiles.map((p) => (
                      <button key={p.id} onClick={() => (setNewMenu(null), openShell(p))}>
                        {p.name}
                      </button>
                    ))}
                    <hr />
                    <button onClick={() => (setNewMenu(null), openLocalTab())}>SSH 빠른 접속 (ssh 명령)</button>
                  </div>
                </>
              )}
            </div>
          </nav>
          <div
            className={`terminals ${split ? 'split' : ''} ${broadcast ? 'broadcast' : ''}`}
            style={split ? { gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` } : undefined}
          >
            {tabs.map((t) => (
              <TerminalTab
                key={t.id}
                sessionId={t.session?.id ?? null}
                localProfile={t.local?.id ?? null}
                highlight={!t.local}
                reconnectable={(!!t.session && !t.session.temp) || !!t.local}
                onQuickConnect={(input) => quickConnect(t, input)}
                active={splitTabs.includes(t) || (!split && t.id === activeTabId)}
                focused={t.id === activeTabId}
                header={
                  splitTabs.includes(t) ? (
                    <div className="pane-head">
                      {broadcastBox(t)}
                      <span className={`dot ${t.state}`} />
                      <span className="tab-title">{t.session?.name ?? t.local?.name ?? '새 탭'}</span>
                    </div>
                  ) : undefined
                }
                onFocus={() => setActiveTabId(t.id)}
                broadcastTo={broadcast && !broadcastOff.has(t.id) ? liveConns.filter((c) => c !== t.connId) : []}
                settings={settings}
                attempt={t.attempt}
                state={t.state}
                message={t.message}
                onConnId={(connId) => updateTab(t.id, { connId })}
                onConnectError={(message) => updateTab(t.id, { state: 'error', message })}
                onReconnect={() => reconnect(t)}
              />
            ))}
            {tabs.length === 0 && (
              <div className="welcome">
                <h1>Skiff</h1>
                <p>왼쪽에서 세션을 더블클릭하거나 새 세션을 만들어 연결하세요.</p>
                <button className="primary" onClick={() => setEditing('new')}>
                  ＋ 새 세션
                </button>
                <ul className="hint">
                  <li>복사 Ctrl+Shift+C · 붙여넣기 Ctrl+Shift+V · 찾기 Ctrl+Shift+F</li>
                  <li>드래그하면 바로 복사 · Alt+드래그는 사각형 선택 · 오른쪽 클릭은 붙여넣기</li>
                </ul>
              </div>
            )}
          </div>
        </main>
        {sftpOpen && (
          <aside className="right-panel">
            <nav className="right-tabs">
              <button className={rightTab === 'files' ? 'on' : ''} onClick={() => setRightTab('files')}>
                파일 (SFTP)
              </button>
              <button className={rightTab === 'tunnels' ? 'on' : ''} onClick={() => setRightTab('tunnels')}>
                터널
              </button>
            </nav>
            {rightTab === 'files' ? (
              <SftpPanel connId={liveConnId} />
            ) : (
              <TunnelPanel
                connId={liveConnId}
                rules={activeTab?.session?.tunnels ?? []}
                onEdit={() => {
                  const saved = sessions.find((s) => s.id === activeTab?.session?.id)
                  if (saved) setEditing(saved)
                }}
              />
            )}
          </aside>
        )}
      </div>

      <footer className="statusbar">
        {activeTab?.local && <span className="muted">로컬 셸 · {activeTab.local.name}</span>}
        {activeTab && !activeTab.session && !activeTab.local && <span className="muted">SSH 빠른 접속 · ssh 사용자@호스트</span>}
        {activeTab?.session ? (
          <>
            <span className={`dot ${activeTab.state}`} />
            <span>{STATE_LABEL[activeTab.state]}</span>
            <span className="muted">
              {activeTab.session.username}@{activeTab.session.host}:{activeTab.session.port}
            </span>
            {activeTab.message && activeTab.state === 'error' && <span className="error">{activeTab.message}</span>}
          </>
        ) : (
          !activeTab && <span className="muted">연결 없음</span>
        )}
        <span className="spacer" />
        {activeTab?.logPath && (
          <button className="link" title={activeTab.logPath} onClick={() => window.api.logs.reveal(activeTab.logPath!)}>
            로그 파일 보기
          </button>
        )}
        <span className="muted">탭 {tabs.length}개</span>
      </footer>

      {editing && (
        <SessionEditor
          session={editing === 'new' ? null : editing}
          groups={groups}
          sessions={sessions}
          onClose={() => setEditing(null)}
          onSaved={async (s, connect) => {
            setEditing(null)
            setSelectedId(s.id)
            await reload()
            if (connect) openTab(s)
          }}
        />
      )}
      {showSettings && (
        <SettingsDialog
          settings={settings}
          onClose={() => setShowSettings(false)}
          onSave={async (s) => {
            setSettings(await window.api.settings.save(s))
            setShowSettings(false)
          }}
        />
      )}
      {editingSnippets && (
        <SnippetEditor
          snippets={snippets}
          onClose={() => setEditingSnippets(false)}
          onSave={async (list) => {
            setSnippets(await window.api.snippets.save(list))
            setEditingSnippets(false)
          }}
        />
      )}
      {prompts[0] && <PromptDialog key={prompts[0].id} request={prompts[0]} onReply={answerPrompt} />}
    </div>
  )
}
