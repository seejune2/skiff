import { useEffect, useState } from 'react'
import type { TunnelRule, TunnelStatus } from '../../shared/types'
import { cleanError } from './TerminalTab'

interface Props {
  connId: string | null
  rules: TunnelRule[]
  onEdit(): void
}

export const describeRule = (r: TunnelRule) =>
  r.type === 'dynamic'
    ? `SOCKS5 127.0.0.1:${r.bindPort}`
    : r.type === 'local'
      ? `127.0.0.1:${r.bindPort} → (서버) ${r.destHost}:${r.destPort}`
      : `(서버) 127.0.0.1:${r.bindPort} → ${r.destHost}:${r.destPort}`

const TYPE_LABEL = { local: 'Local', remote: 'Remote', dynamic: 'Dynamic' }

export function TunnelPanel({ connId, rules, onEdit }: Props) {
  const [states, setStates] = useState<Record<string, Pick<TunnelStatus, 'state' | 'message'>>>({})

  useEffect(() => {
    setStates({})
    if (!connId) return
    void window.api.tunnels
      .states(connId)
      .then((running) => setStates(Object.fromEntries(Object.entries(running).map(([id, on]) => [id, { state: on ? 'running' : 'stopped' }]))))
    return window.api.tunnels.onStatus((s) => {
      if (s.connId === connId) setStates((old) => ({ ...old, [s.ruleId]: { state: s.state, message: s.message } }))
    })
  }, [connId])

  if (!connId) return <p className="hint pad">연결된 SSH 탭을 선택하면 터널을 켜고 끌 수 있습니다.</p>

  return (
    <div className="tunnels">
      {rules.length === 0 && <p className="hint">이 세션에는 터널 규칙이 없습니다.</p>}
      {rules.map((r) => {
        const st = states[r.id]
        const running = st?.state === 'running'
        return (
          <div key={r.id} className="tunnel">
            <span className={`dot ${running ? 'connected' : st?.state === 'error' ? 'error' : ''}`} />
            <div className="tunnel-text">
              <span>
                <b>{TYPE_LABEL[r.type]}</b> {describeRule(r)}
              </span>
              {st?.state === 'error' && <span className="error small">{st.message}</span>}
            </div>
            <button
              onClick={() =>
                running
                  ? window.api.tunnels.stop(connId, r.id)
                  : window.api.tunnels
                      .start(connId, r.id)
                      .catch((err: Error) => setStates((old) => ({ ...old, [r.id]: { state: 'error', message: cleanError(err) } })))
              }
            >
              {running ? '중지' : '시작'}
            </button>
          </div>
        )
      })}
      <p className="hint">
        규칙 추가·수정은 <button className="link" onClick={onEdit}>세션 편집</button>에서 합니다. 바꾼 규칙은 다시 연결하면 적용됩니다.
      </p>
    </div>
  )
}
