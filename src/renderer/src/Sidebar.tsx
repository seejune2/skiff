import { useMemo, useState } from 'react'
import type { Session } from '../../shared/types'

interface Props {
  width: number
  compact: boolean
  onToggleCompact(): void
  onHide(): void
  sessions: Session[]
  selectedId: string | null
  onSelect(id: string): void
  onConnect(session: Session): void
  onEdit(session: Session): void
  onDelete(session: Session): void
}

const DEFAULT_GROUP = '기본'

export function Sidebar({ width, compact, onToggleCompact, onHide, sessions, selectedId, onSelect, onConnect, onEdit, onDelete }: Props) {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const map = new Map<string, Session[]>()
    for (const s of sessions) {
      const hay = `${s.name} ${s.host} ${s.username} ${s.group}`.toLowerCase()
      if (q && !hay.includes(q)) continue
      const g = s.group || DEFAULT_GROUP
      map.set(g, [...(map.get(g) ?? []), s])
    }
    return [...map.entries()]
      .sort(([a], [b]) => (a === DEFAULT_GROUP ? -1 : b === DEFAULT_GROUP ? 1 : a.localeCompare(b, 'ko')))
      .map(([g, list]) => [g, list.sort((a, b) => a.name.localeCompare(b.name, 'ko'))] as const)
  }, [sessions, query])

  const toggle = (g: string) =>
    setCollapsed((old) => {
      const next = new Set(old)
      if (!next.delete(g)) next.add(g)
      return next
    })

  return (
    <aside className={`sidebar ${compact ? 'compact' : ''}`} style={{ width }}>
      <div className="sidebar-head">
        <input className="search" type="search" placeholder="세션 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="icon" title={compact ? '자세히 보기' : '간략히 보기'} onClick={onToggleCompact}>
          {compact ? '자세히' : '간략히'}
        </button>
        <button className="icon" title="세션 목록 접기" onClick={onHide}>
          «
        </button>
      </div>
      <div className="session-list">
        {groups.length === 0 && <p className="hint pad">{sessions.length ? '검색 결과가 없습니다.' : '저장된 세션이 없습니다.'}</p>}
        {groups.map(([group, list]) => {
          const open = query !== '' || !collapsed.has(group)
          return (
            <div key={group}>
              <button className="group-header" onClick={() => toggle(group)}>
                <span className="caret">{open ? '▾' : '▸'}</span>
                {group}
                <span className="count">{list.length}</span>
              </button>
              {open &&
                list.map((s) => (
                  <div
                    key={s.id}
                    className={`session-item ${s.id === selectedId ? 'selected' : ''}`}
                    onClick={() => onSelect(s.id)}
                    onDoubleClick={() => onConnect(s)}
                    title={`${s.username}@${s.host}:${s.port}\n더블클릭하여 연결`}
                  >
                    <div className="session-text">
                      <span className="session-name">
                        {s.protocol === 'rdp' && '🖥 '}
                        {s.name}
                      </span>
                      {!compact && <span className="session-host">
                        {s.username}@{s.host}
                        {s.port !== 22 && `:${s.port}`}
                      </span>}
                    </div>
                    <div className="session-actions">
                      <button title="편집" onClick={(e) => (e.stopPropagation(), onEdit(s))}>
                        ✎
                      </button>
                      <button title="삭제" onClick={(e) => (e.stopPropagation(), onDelete(s))}>
                        🗑
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
