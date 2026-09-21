import { useState } from 'react'
import type { Snippet } from '../../shared/types'

interface Props {
  snippets: Snippet[]
  onSave(list: Snippet[]): void
  onClose(): void
}

export function SnippetEditor({ snippets, onSave, onClose }: Props) {
  const [list, setList] = useState(snippets)
  const set = (id: string, patch: Partial<Snippet>) => setList((old) => old.map((s) => (s.id === id ? { ...s, ...patch } : s)))

  return (
    <div className="modal-backdrop" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="modal wide">
        <h2>명령 스니펫</h2>
        <p className="hint">여러 줄이면 한 줄씩 차례로 실행됩니다. 이름이나 명령이 빈 항목은 저장하지 않습니다.</p>
        <div className="snippet-list">
          {list.map((s) => (
            <div key={s.id} className="snippet-edit">
              <div className="row">
                <input placeholder="이름 (예: 디스크 확인)" value={s.name} onChange={(e) => set(s.id, { name: e.target.value })} />
                <button className="icon" title="삭제" onClick={() => setList((old) => old.filter((x) => x.id !== s.id))}>
                  ✕
                </button>
              </div>
              <textarea
                rows={Math.min(6, s.command.split('\n').length + 1)}
                placeholder="명령 (예: df -h)"
                value={s.command}
                onChange={(e) => set(s.id, { command: e.target.value })}
              />
            </div>
          ))}
        </div>
        <div>
          <button onClick={() => setList((old) => [...old, { id: crypto.randomUUID(), name: '', command: '' }])}>＋ 스니펫 추가</button>
        </div>
        <div className="modal-actions">
          <button onClick={onClose}>취소</button>
          <button className="primary" onClick={() => onSave(list)}>
            저장
          </button>
        </div>
      </div>
    </div>
  )
}
