import { useMemo, useState } from 'react'
import type { Session } from '../../shared/types'

interface Props {
  width: number
  compact: boolean
  onToggleCompact(): void
  onHide(): void
  sessions: Session[]
  /** 최근에 연 세션 id, 최근 것이 앞 */
  recentIds: string[]
  selectedId: string | null
  onSelect(id: string): void
  onConnect(session: Session): void
  onEdit(session: Session): void
  onDelete(session: Session): void
  onDuplicate(session: Session): void
  /** 그룹으로 끌어다 놓아 옮기기 */
  onMove(session: Session, group: string): void
}

const DEFAULT_GROUP = '기본'

/** 그룹 이름의 '/'는 하위 그룹. path는 '서버/웹'처럼 전체 경로. */
interface GroupNode {
  name: string
  path: string
  sessions: Session[]
  children: GroupNode[]
  /** 하위 그룹까지 합친 세션 수 */
  count: number
}

export function buildTree(sessions: Session[]): GroupNode[] {
  const root: GroupNode = { name: '', path: '', sessions: [], children: [], count: 0 }
  for (const s of sessions) {
    let node = root
    for (const name of (s.group || DEFAULT_GROUP).split('/')) {
      const path = node.path ? `${node.path}/${name}` : name
      let child = node.children.find((c) => c.name === name)
      if (!child) node.children.push((child = { name, path, sessions: [], children: [], count: 0 }))
      node = child
    }
    node.sessions.push(s)
  }
  const finish = (node: GroupNode): number => {
    node.children.sort((a, b) => (a.path === DEFAULT_GROUP ? -1 : b.path === DEFAULT_GROUP ? 1 : a.name.localeCompare(b.name, 'ko')))
    node.sessions.sort((a, b) => a.name.localeCompare(b.name, 'ko'))
    return (node.count = node.sessions.length + node.children.reduce((n, c) => n + finish(c), 0))
  }
  finish(root)
  return root.children
}
/** 접힘 상태 키. 같은 이름의 그룹과 겹치지 않게 한다. */
const RECENT_KEY = '\0recent'

export function Sidebar({ width, compact, onToggleCompact, onHide, sessions, recentIds, selectedId, onSelect, onConnect, onEdit, onDelete, onDuplicate, onMove }: Props) {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [dropGroup, setDropGroup] = useState<string | null>(null)

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    return buildTree(sessions.filter((s) => !q || `${s.name} ${s.host} ${s.username} ${s.group}`.toLowerCase().includes(q)))
  }, [sessions, query])

  const recent = recentIds.map((id) => sessions.find((s) => s.id === id)).filter((s): s is Session => !!s)

  const toggle = (g: string) =>
    setCollapsed((old) => {
      const next = new Set(old)
      if (!next.delete(g)) next.add(g)
      return next
    })

  const item = (s: Session, depth = 0) => (
    <div
      key={s.id}
      style={depth ? { paddingLeft: 22 + depth * 14 } : undefined}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/session', s.id)}
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
        <button title="복제" onClick={(e) => (e.stopPropagation(), onDuplicate(s))}>
          ⧉
        </button>
        <button title="삭제" onClick={(e) => (e.stopPropagation(), onDelete(s))}>
          🗑
        </button>
      </div>
    </div>
  )

  const groupView = (node: GroupNode, depth: number) => {
    const open = query !== '' || !collapsed.has(node.path)
    return (
      <div key={node.path}>
        <button
          className={`group-header ${dropGroup === node.path ? 'drop' : ''}`}
          style={depth ? { paddingLeft: 10 + depth * 14 } : undefined}
          onClick={() => toggle(node.path)}
          onDragOver={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setDropGroup(node.path)
          }}
          onDragLeave={() => setDropGroup(null)}
          onDrop={(e) => {
            e.preventDefault()
            setDropGroup(null)
            const moved = sessions.find((s) => s.id === e.dataTransfer.getData('text/session'))
            if (moved) onMove(moved, node.path === DEFAULT_GROUP ? '' : node.path)
          }}
        >
          <span className="caret">{open ? '▾' : '▸'}</span>
          {node.name}
          <span className="count">{node.count}</span>
        </button>
        {open && (
          <>
            {node.children.map((c) => groupView(c, depth + 1))}
            {node.sessions.map((s) => item(s, depth))}
          </>
        )}
      </div>
    )
  }

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
        {!query && recent.length > 0 && (
          <div>
            <button className="group-header" onClick={() => toggle(RECENT_KEY)}>
              <span className="caret">{collapsed.has(RECENT_KEY) ? '▸' : '▾'}</span>
              최근
              <span className="count">{recent.length}</span>
            </button>
            {!collapsed.has(RECENT_KEY) && recent.map((s) => item(s))}
          </div>
        )}
        {groups.map((g) => groupView(g, 0))}
      </div>
    </aside>
  )
}
