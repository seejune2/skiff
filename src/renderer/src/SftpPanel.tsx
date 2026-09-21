import { useCallback, useEffect, useState } from 'react'
import type { RemoteEntry, Transfer } from '../../shared/types'
import { cleanError } from './TerminalTab'

interface Props {
  /** 연결된 탭의 connId. 없으면 안내만 보인다. */
  connId: string | null
}

const join = (dir: string, name: string) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`)
const parent = (dir: string) => dir.replace(/\/[^/]+\/?$/, '') || '/'

function size(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let i = -1
  do {
    n /= 1024
    i++
  } while (n >= 1024 && i < units.length - 1)
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`
}

const date = (sec: number) => new Date(sec * 1000).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })

export function SftpPanel({ connId }: Props) {
  const [path, setPath] = useState('')
  const [input, setInput] = useState('')
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  // 이름 바꾸기와 새 폴더는 목록 안에서 바로 입력한다 (Electron은 window.prompt를 지원하지 않음).
  const [editing, setEditing] = useState<{ original: string | null; name: string } | null>(null)
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [loading, setLoading] = useState(false)
  const [dropping, setDropping] = useState(false)

  const open = useCallback(
    async (target: string) => {
      if (!connId) return
      setLoading(true)
      try {
        const res = await window.api.sftp.list(connId, target)
        setPath(res.path)
        setInput(res.path)
        setEntries(res.entries)
        setError('')
        setSelected(null)
      } catch (err) {
        setError(cleanError(err as Error))
      } finally {
        setLoading(false)
      }
    },
    [connId]
  )

  useEffect(() => {
    setEntries([])
    setPath('')
    if (connId) void open('.')
  }, [connId, open])

  useEffect(
    () =>
      window.api.sftp.onTransfer((t) => {
        setTransfers((old) => (old.some((o) => o.id === t.id) ? old.map((o) => (o.id === t.id ? { ...t } : o)) : [...old, { ...t }]))
        if (t.state === 'done' && t.direction === 'upload' && t.connId === connId) void open(path || '.')
      }),
    [connId, open, path]
  )

  const run = async (fn: () => Promise<void>) => {
    try {
      await fn()
      await open(path)
    } catch (err) {
      setError(cleanError(err as Error))
    }
  }

  const finishEdit = () => {
    if (!editing || !connId) return
    const name = editing.name.trim()
    setEditing(null)
    if (!name || name === editing.original || name.includes('/')) return
    void run(() =>
      editing.original === null
        ? window.api.sftp.mkdir(connId, join(path, name))
        : window.api.sftp.rename(connId, join(path, editing.original), join(path, name))
    )
  }

  const remove = (e: RemoteEntry) => {
    if (!connId || !window.confirm(`"${e.name}"을(를) 삭제할까요?${e.type === 'dir' ? '\n(빈 폴더만 삭제됩니다)' : ''}`)) return
    void run(() => window.api.sftp.delete(connId, join(path, e.name), e.type === 'dir'))
  }

  const activate = (e: RemoteEntry) => {
    if (!connId) return
    if (e.type === 'file') window.api.sftp.download(connId, join(path, e.name)).catch((err: Error) => setError(cleanError(err)))
    else void open(join(path, e.name))
  }

  if (!connId) return <p className="hint pad">연결된 SSH 탭을 선택하면 파일 목록이 보입니다.</p>

  const mine = transfers.filter((t) => t.connId === connId)
  const editRow = (
    <input
      autoFocus
      className="sftp-edit"
      value={editing?.name ?? ''}
      onChange={(e) => setEditing((old) => old && { ...old, name: e.target.value })}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finishEdit()
        if (e.key === 'Escape') setEditing(null)
      }}
      onBlur={finishEdit}
    />
  )

  return (
    <div className="sftp">
      <div className="sftp-bar">
        <button className="icon" title="상위 폴더" onClick={() => void open(parent(path))}>
          ↑
        </button>
        <input
          className="sftp-path"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void open(input)}
        />
        <button className="icon" title="새로고침" onClick={() => void open(path)}>
          ⟳
        </button>
      </div>
      <div className="sftp-bar">
        <button onClick={() => void run(() => window.api.sftp.upload(connId, path))}>⬆ 파일</button>
        <button onClick={() => void run(() => window.api.sftp.uploadFolder(connId, path))}>⬆ 폴더</button>
        <button onClick={() => setEditing({ original: null, name: '' })}>＋ 새 폴더</button>
      </div>
      {loading && <p className="hint pad">불러오는 중…</p>}
      {error && <p className="error pad small">{error}</p>}
      <div
        className={`sftp-list ${dropping ? 'dropping' : ''}`}
        title="탐색기에서 파일이나 폴더를 끌어다 놓으면 이 폴더로 올립니다"
        onDragOver={(e) => {
          e.preventDefault()
          setDropping(true)
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDropping(false)
          const files = [...e.dataTransfer.files]
          if (files.length) void run(() => window.api.sftp.uploadDropped(connId, path, files))
        }}
      >
        {editing?.original === null && <div className="sftp-row">📁 {editRow}</div>}
        {entries.map((e) => (
          <div
            key={e.name}
            className={`sftp-row ${selected === e.name ? 'selected' : ''}`}
            onClick={() => setSelected(e.name)}
            onDoubleClick={() => activate(e)}
            title={e.type === 'file' ? '더블클릭: 다운로드' : '더블클릭: 열기'}
          >
            <span className="sftp-icon">{e.type === 'dir' ? '📁' : e.type === 'link' ? '🔗' : '📄'}</span>
            {editing?.original === e.name ? (
              editRow
            ) : (
              <span className="sftp-name">{e.name}</span>
            )}
            <span className="sftp-meta">{e.type === 'file' ? size(e.size) : ''}</span>
            <span className="sftp-meta">{date(e.mtime)}</span>
            <span className="sftp-actions">
              {e.type === 'file' && (
                <button title="다운로드" onClick={(ev) => (ev.stopPropagation(), activate(e))}>
                  ⬇
                </button>
              )}
              {e.type === 'dir' && (
                <button
                  title="폴더 통째로 다운로드"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    window.api.sftp.downloadFolder(connId, join(path, e.name)).catch((err: Error) => setError(cleanError(err)))
                  }}
                >
                  ⬇
                </button>
              )}
              <button title="이름 바꾸기" onClick={(ev) => (ev.stopPropagation(), setEditing({ original: e.name, name: e.name }))}>
                ✎
              </button>
              <button title="삭제" onClick={(ev) => (ev.stopPropagation(), remove(e))}>
                🗑
              </button>
            </span>
          </div>
        ))}
      </div>
      {mine.length > 0 && (
        <div className="transfers">
          <div className="transfer-head">
            <span className="transfer-name muted">
              전송 {mine.filter((t) => t.state === 'running' || t.state === 'queued').length}개 진행·대기
            </span>
            <button
              className="link"
              onClick={() => {
                const done = mine.filter((t) => t.state === 'done' || t.state === 'cancelled')
                for (const t of done) window.api.sftp.forget(t.id)
                setTransfers((old) => old.filter((o) => !done.includes(o)))
              }}
            >
              끝난 항목 지우기
            </button>
          </div>
          {mine.map((t) => (
            <div key={t.id} className={`transfer ${t.state}`}>
              <div className="transfer-head">
                <span className="transfer-name">
                  {t.direction === 'upload' ? '⬆' : '⬇'} {t.name}
                </span>
                <span className="muted">
                  {t.state === 'running' && t.total ? `${Math.floor((t.done / t.total) * 100)}%` : ''}
                  {t.state === 'queued' && '대기'}
                  {t.state === 'done' && '완료'}
                  {t.state === 'cancelled' && '취소됨'}
                  {t.state === 'error' && '실패'}
                </span>
                {t.state === 'running' || t.state === 'queued' ? (
                  <button className="link" onClick={() => window.api.sftp.cancel(t.id)}>
                    취소
                  </button>
                ) : (
                  <>
                    {t.state !== 'done' && (
                      <button className="link" onClick={() => window.api.sftp.retry(t.id)}>
                        재시도
                      </button>
                    )}
                    <button
                      className="link"
                      onClick={() => {
                        window.api.sftp.forget(t.id)
                        setTransfers((old) => old.filter((o) => o.id !== t.id))
                      }}
                    >
                      지우기
                    </button>
                  </>
                )}
              </div>
              {t.state === 'running' && <progress max={t.total || 1} value={t.done} />}
              {t.message && <p className="error small">{t.message}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
