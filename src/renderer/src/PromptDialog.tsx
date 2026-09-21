import { useState } from 'react'
import type { PromptReply, PromptRequest } from '../../shared/types'

interface Props {
  request: PromptRequest
  onReply(reply: PromptReply): void
}

export function PromptDialog({ request, onReply }: Props) {
  const [values, setValues] = useState<string[]>(() =>
    request.kind === 'keyboard-interactive' ? request.prompts.map(() => '') : ['']
  )
  const [save, setSave] = useState(false)
  const set = (i: number, v: string) => setValues((old) => old.map((o, j) => (j === i ? v : o)))

  const submit = () => {
    if (request.kind === 'hostkey') onReply(true)
    else if (request.kind === 'keyboard-interactive') onReply(values)
    else onReply({ value: values[0], save })
  }

  const changed = request.kind === 'hostkey' && !!request.previousFingerprint

  return (
    <div className="modal-backdrop" onKeyDown={(e) => e.key === 'Escape' && onReply(null)}>
      <form
        className={`modal ${changed ? 'danger' : ''}`}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {request.kind === 'hostkey' && (
          <>
            <h2>{changed ? '⚠ 호스트 키가 바뀌었습니다' : '처음 접속하는 서버입니다'}</h2>
            <p>
              {changed
                ? '저장된 키와 서버가 보낸 키가 다릅니다. 서버를 재설치한 것이 아니라면 중간자 공격일 수 있습니다. 관리자에게 확인하기 전에는 연결하지 마세요.'
                : '아래 지문이 서버의 실제 호스트 키와 같은지 확인한 뒤 연결하세요.'}
            </p>
            <dl className="facts">
              <dt>서버</dt>
              <dd>
                {request.host}:{request.port}
              </dd>
              <dt>키 종류</dt>
              <dd>{request.keyType}</dd>
              <dt>{changed ? '새 지문' : '지문'}</dt>
              <dd className="mono">{request.fingerprint}</dd>
              {changed && (
                <>
                  <dt>이전 지문</dt>
                  <dd className="mono">{request.previousFingerprint}</dd>
                </>
              )}
            </dl>
          </>
        )}

        {request.kind === 'password' && (
          <>
            <h2>비밀번호 입력</h2>
            <p>{request.target}</p>
            {request.retry && <p className="error">비밀번호가 올바르지 않습니다. 다시 입력하세요.</p>}
            <input type="password" autoFocus value={values[0]} onChange={(e) => set(0, e.target.value)} />
            {request.canSave && (
              <label className="check">
                <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
                비밀번호 저장 (OS 보안 저장소로 암호화)
              </label>
            )}
          </>
        )}

        {request.kind === 'passphrase' && (
          <>
            <h2>개인키 암호 입력</h2>
            <p className="mono small">{request.keyPath}</p>
            {request.retry && <p className="error">암호가 올바르지 않습니다. 다시 입력하세요.</p>}
            <input type="password" autoFocus value={values[0]} onChange={(e) => set(0, e.target.value)} />
          </>
        )}

        {request.kind === 'keyboard-interactive' && (
          <>
            <h2>{request.name || '추가 인증'}</h2>
            <p>{request.target}</p>
            {request.instructions && <p className="pre">{request.instructions}</p>}
            {request.prompts.map((p, i) => (
              <label key={i} className="field">
                <span className="pre">{p.prompt}</span>
                <input
                  type={p.echo ? 'text' : 'password'}
                  autoFocus={i === 0}
                  value={values[i]}
                  onChange={(e) => set(i, e.target.value)}
                />
              </label>
            ))}
          </>
        )}

        <div className="modal-actions">
          <button type="button" onClick={() => onReply(null)} autoFocus={changed}>
            {changed ? '연결하지 않음' : '취소'}
          </button>
          <button type="submit" className={changed ? 'danger' : 'primary'} autoFocus={request.kind === 'hostkey' && !changed}>
            {request.kind === 'hostkey' ? (changed ? '새 키를 신뢰하고 연결' : '신뢰하고 연결') : '확인'}
          </button>
        </div>
      </form>
    </div>
  )
}
