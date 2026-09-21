import { useEffect, useState } from 'react'
import type { Session, SessionInput, TunnelRule } from '../../shared/types'
import { cleanError } from './TerminalTab'

interface Props {
  session: Session | null
  groups: string[]
  onSaved(session: Session, connect: boolean): void
  onClose(): void
}

const empty: SessionInput = { name: '', group: '', host: '', port: 22, username: '', authType: 'password', privateKeyPath: '', x11: false, tunnels: [] }

export function SessionEditor({ session, groups, onSaved, onClose }: Props) {
  const [form, setForm] = useState<SessionInput>(session ?? empty)
  const [error, setError] = useState('')
  const [hasPassword, setHasPassword] = useState(false)
  const set = <K extends keyof SessionInput>(key: K, value: SessionInput[K]) => setForm((f) => ({ ...f, [key]: value }))

  const tunnels = form.tunnels ?? []
  const setRule = (id: string, patch: Partial<TunnelRule>) =>
    set('tunnels', tunnels.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const addRule = () =>
    set('tunnels', [...tunnels, { id: crypto.randomUUID(), type: 'local', bindPort: 8080, destHost: 'localhost', destPort: 80, autoStart: true }])

  useEffect(() => {
    if (session) void window.api.secrets.has(session.id).then(setHasPassword)
  }, [session])

  const save = async (connect: boolean) => {
    try {
      onSaved(await window.api.sessions.save(form), connect)
    } catch (err) {
      setError(cleanError(err as Error))
    }
  }

  return (
    <div className="modal-backdrop" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <form
        className="modal wide"
        onSubmit={(e) => {
          e.preventDefault()
          void save(true)
        }}
      >
        <h2>{session ? '세션 편집' : '새 세션'}</h2>
        <div className="grid">
          <label className="field span2">
            <span>이름</span>
            <input value={form.name} placeholder="비워 두면 사용자@호스트" onChange={(e) => set('name', e.target.value)} />
          </label>
          <label className="field span2">
            <span>그룹</span>
            <input list="groups" value={form.group} onChange={(e) => set('group', e.target.value)} />
            <datalist id="groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </label>
          <fieldset className="field span4">
            <span>종류</span>
            <div className="radios">
              <label>
                <input type="radio" checked={form.protocol !== 'rdp'} onChange={() => setForm((f) => ({ ...f, protocol: 'ssh', port: 22 }))} />
                SSH
              </label>
              <label>
                <input type="radio" checked={form.protocol === 'rdp'} onChange={() => setForm((f) => ({ ...f, protocol: 'rdp', port: 3389 }))} />
                원격 데스크톱 (RDP)
              </label>
            </div>
          </fieldset>
          <label className="field span3">
            <span>호스트</span>
            <input autoFocus value={form.host} placeholder="example.com 또는 192.168.0.10" onChange={(e) => set('host', e.target.value)} />
          </label>
          <label className="field">
            <span>포트</span>
            <input type="number" min={1} max={65535} value={form.port} onChange={(e) => set('port', Number(e.target.value))} />
          </label>
          {form.protocol !== 'rdp' && (
            <>
          <label className="field span4">
            <span>사용자명</span>
            <input value={form.username} onChange={(e) => set('username', e.target.value)} />
          </label>
          <fieldset className="field span4">
            <span>인증 방식</span>
            <div className="radios">
              <label>
                <input type="radio" checked={form.authType === 'password'} onChange={() => set('authType', 'password')} />
                비밀번호
              </label>
              <label>
                <input type="radio" checked={form.authType === 'key'} onChange={() => set('authType', 'key')} />
                개인키
              </label>
            </div>
          </fieldset>
          {form.authType === 'key' && (
            <label className="field span4">
              <span>개인키 파일</span>
              <div className="row">
                <input value={form.privateKeyPath} onChange={(e) => set('privateKeyPath', e.target.value)} />
                <button
                  type="button"
                  onClick={async () => {
                    const path = await window.api.sessions.pickKey()
                    if (path) set('privateKeyPath', path)
                  }}
                >
                  찾아보기
                </button>
              </div>
            </label>
          )}
          <label className="check span4">
            <input type="checkbox" checked={!!form.x11} onChange={(e) => set('x11', e.target.checked)} />
            X11 포워딩 (virt-manager 같은 GUI 프로그램을 내 화면에 띄움)
          </label>
          <div className="field span4">
            <span>포트포워딩 (내 PC 쪽은 127.0.0.1에만 열림)</span>
            {tunnels.map((r) => (
              <div key={r.id} className="tunnel-row">
                <select value={r.type} onChange={(e) => setRule(r.id, { type: e.target.value as TunnelRule['type'] })}>
                  <option value="local">Local</option>
                  <option value="remote">Remote</option>
                  <option value="dynamic">Dynamic</option>
                </select>
                <input
                  type="number"
                  title={r.type === 'remote' ? '서버에서 열 포트' : '내 PC에서 열 포트'}
                  value={r.bindPort}
                  onChange={(e) => setRule(r.id, { bindPort: Number(e.target.value) })}
                />
                {r.type === 'dynamic' ? (
                  <span className="hint">SOCKS5 프록시</span>
                ) : (
                  <input
                    title={r.type === 'local' ? '서버에서 본 목적지 호스트' : '내 PC에서 본 목적지 호스트'}
                    value={r.destHost}
                    onChange={(e) => setRule(r.id, { destHost: e.target.value })}
                  />
                )}
                {r.type === 'dynamic' ? (
                  <span />
                ) : (
                  <input type="number" title="목적지 포트" value={r.destPort} onChange={(e) => setRule(r.id, { destPort: Number(e.target.value) })} />
                )}
                <label className="check" title="연결할 때 자동 시작">
                  <input type="checkbox" checked={r.autoStart} onChange={(e) => setRule(r.id, { autoStart: e.target.checked })} />
                  자동
                </label>
                <button type="button" className="icon" title="규칙 삭제" onClick={() => set('tunnels', tunnels.filter((x) => x.id !== r.id))}>
                  ✕
                </button>
              </div>
            ))}
            <div>
              <button type="button" onClick={addRule}>
                ＋ 규칙 추가
              </button>
            </div>
          </div>
            </>
          )}
          {form.protocol === 'rdp' && (
            <p className="hint span4">더블클릭하면 Windows 원격 데스크톱이 열립니다. 사용자명과 비밀번호는 그 창에서 입력하고 Windows가 기억합니다.</p>
          )}
          {form.protocol !== 'rdp' && form.authType === 'password' && (
            <p className="hint span4">
              비밀번호는 연결할 때 입력합니다.
              {hasPassword && (
                <>
                  {' '}이 세션에는 저장된 비밀번호가 있습니다.{' '}
                  <button
                    type="button"
                    className="link"
                    onClick={async () => {
                      await window.api.secrets.delete(session!.id)
                      setHasPassword(false)
                    }}
                  >
                    저장된 비밀번호 삭제
                  </button>
                </>
              )}
            </p>
          )}
        </div>
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            취소
          </button>
          <button type="button" onClick={() => void save(false)}>
            저장
          </button>
          <button type="submit" className="primary">
            저장 후 연결
          </button>
        </div>
      </form>
    </div>
  )
}
