import { useCallback, useEffect, useState } from 'react'
import type { RemoteEdit, RemoteEntry, Transfer } from '../../shared/types'
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

const octal = (mode: number) => mode.toString(8).padStart(3, '0')
const rwx = (mode: number) => [6, 3, 0].map((shift) => ['r', 'w', 'x'].map((c, i) => (mode >> shift) & (4 >> i) ? c : '-').join('')).join('')

/** 내 PC 경로는 Windows면 \\, 아니면 / */
const pcJoin = (dir: string, name: string) => {
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.endsWith(sep) ? dir + name : dir + sep + name
}

const icon = (e: RemoteEntry) => (e.type === 'dir' ? '📁' : e.type === 'link' ? '🔗' : '📄')

const date = (sec: number) => new Date(sec * 1000).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })

export function SftpPanel({ connId }: Props) {
  const [path, setPath] = useState('')
  const [input, setInput] = useState('')
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  // 이름 바꾸기, 새 폴더, 권한은 목록 안에서 바로 입력한다 (Electron은 window.prompt를 지원하지 않음).
  // mode면 name에 8진수 권한(644)을 담는다.
  const [editing, setEditing] = useState<{ original: string | null; name: string; mode?: boolean } | null>(null)
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [loading, setLoading] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [edits, setEdits] = useState<RemoteEdit[]>([])
  // 내 PC 목록 (위아래 2단). 켜 두면 ⬇는 대화상자 없이 지금 보고 있는 내 PC 폴더로 받는다.
  const [pcOpen, setPcOpen] = useState(() => {
    try {
      return localStorage.getItem('sftpPcOpen') === '1'
    } catch {
      return false
    }
  })
  const [pcPath, setPcPath] = useState('')
  const [pcInput, setPcInput] = useState('')
  const [pcEntries, setPcEntries] = useState<RemoteEntry[]>([])

  const openPc = useCallback(async (target: string) => {
    try {
      const res = await window.api.localFiles.list(target)
      setPcPath(res.path)
      setPcInput(res.path)
      setPcEntries(res.entries)
    } catch (err) {
      setError(cleanError(err as Error))
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('sftpPcOpen', pcOpen ? '1' : '0')
    } catch {}
    if (pcOpen && !pcPath) void openPc('')
  }, [pcOpen, pcPath, openPc])

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

  useEffect(() => {
    void window.api.edits.list().then(setEdits)
    return window.api.edits.onStatus((s) =>
      setEdits((old) => (s.state === 'closed' ? old.filter((o) => o.local !== s.local) : [...old.filter((o) => o.local !== s.local), s]))
    )
  }, [])

  useEffect(
    () =>
      window.api.sftp.onTransfer((t) => {
        setTransfers((old) => (old.some((o) => o.id === t.id) ? old.map((o) => (o.id === t.id ? { ...t } : o)) : [...old, { ...t }]))
        if (t.state === 'done' && t.direction === 'upload' && t.connId === connId) void open(path || '.')
        if (t.state === 'done' && t.direction === 'download' && pcOpen) void openPc(pcPath)
      }),
    [connId, open, path, pcOpen, pcPath, openPc]
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
    if (editing.mode) {
      const entry = entries.find((e) => e.name === editing.original)
      if (!/^[0-7]{3,4}$/.test(name)) return setError('권한은 644처럼 8진수 3~4자리로 입력하세요.')
      if (entry && parseInt(name, 8) !== entry.mode) void run(() => window.api.sftp.chmod(connId, join(path, entry.name), parseInt(name, 8)))
      return
    }
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

  // 파일 더블클릭 = 편집기로 열기. 저장하면 자동으로 다시 올라간다.
  const activate = (e: RemoteEntry) => {
    if (!connId) return
    if (e.type === 'file') window.api.edits.open(connId, join(path, e.name)).catch((err: Error) => setError(cleanError(err)))
    else void open(join(path, e.name))
  }

  /** 서버 파일·폴더 받기: 내 PC 목록이 열려 있으면 거기로, 아니면 위치를 묻는다. */
  const download = (e: RemoteEntry) => {
    if (!connId) return
    const remote = join(path, e.name)
    const isDir = e.type === 'dir'
    const job = pcOpen
      ? window.api.sftp.downloadTo(connId, remote, pcPath, isDir)
      : isDir
        ? window.api.sftp.downloadFolder(connId, remote)
        : window.api.sftp.download(connId, remote)
    job.catch((err: Error) => setError(cleanError(err)))
  }
  const uploadPc = (paths: string[]) => connId && void run(() => window.api.sftp.uploadPaths(connId, path, paths))

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
      {pcOpen && (
        <div className="sftp-pc">
          <div className="sftp-bar">
            <span className="sftp-caption">내 PC</span>
            <button className="icon" title="상위 폴더" onClick={() => void openPc(pcJoin(pcPath, '..'))}>
              ↑
            </button>
            <input
              className="sftp-path"
              spellCheck={false}
              value={pcInput}
              onChange={(e) => setPcInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void openPc(pcInput)}
            />
            <button className="icon" title="새로고침" onClick={() => void openPc(pcPath)}>
              ⟳
            </button>
          </div>
          <div
            className="sftp-list"
            title="서버 목록에서 끌어다 놓으면 이 폴더로 받습니다"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const raw = e.dataTransfer.getData('text/skiff-remote')
              if (raw) download(JSON.parse(raw) as RemoteEntry)
            }}
          >
            {pcEntries.map((e) => (
              <div
                key={e.name}
                className="sftp-row"
                draggable
                onDragStart={(ev) => ev.dataTransfer.setData('text/skiff-local', pcJoin(pcPath, e.name))}
                onDoubleClick={() => (e.type === 'dir' ? void openPc(pcJoin(pcPath, e.name)) : uploadPc([pcJoin(pcPath, e.name)]))}
                title={e.type === 'dir' ? '더블클릭: 열기' : '더블클릭: 서버의 지금 폴더로 올리기'}
              >
                <span className="sftp-icon">{icon(e)}</span>
                <span className="sftp-name">{e.name}</span>
                <span className="sftp-meta">{e.type === 'file' ? size(e.size) : ''}</span>
                <span className="sftp-meta">{date(e.mtime)}</span>
                <span className="sftp-actions">
                  <button title="서버의 지금 폴더로 올리기" onClick={() => uploadPc([pcJoin(pcPath, e.name)])}>
                    ⬆
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="sftp-bar">
        {pcOpen && <span className="sftp-caption">서버</span>}
        <button className="icon" title="상위 폴더" onClick={() => void open(parent(path))}>
          ↑
        </button>
        <input
          className="sftp-path"
          spellCheck={false}
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
        <button className={pcOpen ? 'on' : ''} title="내 PC 파일 목록을 위에 같이 보기" onClick={() => setPcOpen(!pcOpen)}>
          💻 내 PC
        </button>
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
          const fromPc = e.dataTransfer.getData('text/skiff-local')
          if (fromPc) return uploadPc([fromPc])
          const files = [...e.dataTransfer.files]
          if (files.length) void run(() => window.api.sftp.uploadDropped(connId, path, files))
        }}
      >
        {editing?.original === null && <div className="sftp-row">📁 {editRow}</div>}
        {entries.map((e) => (
          <div
            key={e.name}
            className={`sftp-row ${selected === e.name ? 'selected' : ''}`}
            draggable
            onDragStart={(ev) => ev.dataTransfer.setData('text/skiff-remote', JSON.stringify(e))}
            onClick={() => setSelected(e.name)}
            onDoubleClick={() => activate(e)}
            title={e.type === 'file' ? '더블클릭: 편집기로 열기 (저장하면 자동 업로드)' : '더블클릭: 열기'}
          >
            <span className="sftp-icon">{icon(e)}</span>
            {editing?.original === e.name && !editing.mode ? (
              editRow
            ) : (
              <span className="sftp-name">{e.name}</span>
            )}
            {editing?.original === e.name && editing.mode && <span className="sftp-mode-edit">{editRow}</span>}
            <span className="sftp-meta" title={rwx(e.mode)}>
              {octal(e.mode)}
            </span>
            <span className="sftp-meta">{e.type === 'file' ? size(e.size) : ''}</span>
            <span className="sftp-meta">{date(e.mtime)}</span>
            <span className="sftp-actions">
              {e.type !== 'link' && (
                <button title={pcOpen ? '내 PC의 지금 폴더로 받기' : e.type === 'dir' ? '폴더 통째로 다운로드' : '다운로드'} onClick={(ev) => (ev.stopPropagation(), download(e))}>
                  ⬇
                </button>
              )}
              <button title={`권한 바꾸기 (지금 ${octal(e.mode)} ${rwx(e.mode)})`} onClick={(ev) => (ev.stopPropagation(), setEditing({ original: e.name, name: octal(e.mode), mode: true }))}>
                🔐
              </button>
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
      {edits.filter((e) => e.connId === connId).length > 0 && (
        <div className="transfers">
          {edits
            .filter((e) => e.connId === connId)
            .map((e) => (
              <div key={e.local} className={`transfer ${e.state === 'error' ? 'error' : ''}`}>
                <div className="transfer-head">
                  <span className="transfer-name" title={e.local}>
                    ✎ {e.remote.split('/').pop()}
                  </span>
                  <span className="muted">
                    {e.state === 'open' && '편집 중'}
                    {e.state === 'uploading' && '올리는 중'}
                    {e.state === 'saved' && '저장됨'}
                    {e.state === 'error' && '실패'}
                  </span>
                  <button className="link" onClick={() => window.api.edits.close(e.local)}>
                    닫기
                  </button>
                </div>
                {e.message && <p className="error small">{e.message}</p>}
              </div>
            ))}
        </div>
      )}
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
