import { useState } from 'react'
import type { ITheme } from '@xterm/xterm'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/types'

interface Props {
  settings: Settings
  onSave(s: Settings): void
  onClose(): void
}

/** 터미널 색 조합. 지정하지 않은 색은 xterm 기본값을 쓴다. */
export const TERMINAL_THEMES: Record<Settings['terminalTheme'], { label: string; theme: ITheme }> = {
  dark: { label: '어두움', theme: { background: '#1b1d23', foreground: '#d7dae0', cursor: '#d7dae0', selectionBackground: '#3d5a8a' } },
  light: { label: '밝음', theme: { background: '#fdfdfd', foreground: '#24292f', cursor: '#24292f', selectionBackground: '#bcd5f5' } },
  solarized: {
    label: 'Solarized Dark',
    theme: { background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', selectionBackground: '#274b57' }
  }
}

const FONTS = [
  { label: 'Cascadia Mono (기본)', value: DEFAULT_SETTINGS.fontFamily },
  { label: 'Consolas', value: 'Consolas, "Malgun Gothic", monospace' },
  { label: 'D2Coding', value: '"D2Coding", Consolas, monospace' },
  { label: 'Noto Sans Mono', value: '"Noto Sans Mono", Consolas, monospace' },
  { label: 'Nanum Gothic Coding', value: '"NanumGothicCoding", Consolas, monospace' }
]

export function SettingsDialog({ settings, onSave, onClose }: Props) {
  const [form, setForm] = useState(settings)
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setForm((f) => ({ ...f, [key]: value }))
  const theme = TERMINAL_THEMES[form.terminalTheme].theme

  return (
    <div className="modal-backdrop" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <form
        className="modal wide"
        onSubmit={(e) => {
          e.preventDefault()
          onSave(form)
        }}
      >
        <h2>설정</h2>
        <div className="grid">
          <label className="field span2">
            <span>터미널 글꼴</span>
            <input list="fonts" value={form.fontFamily} onChange={(e) => set('fontFamily', e.target.value)} />
            <datalist id="fonts">
              {FONTS.map((f) => (
                <option key={f.label} value={f.value}>
                  {f.label}
                </option>
              ))}
            </datalist>
          </label>
          <label className="field">
            <span>글자 크기</span>
            <input type="number" min={8} max={40} value={form.fontSize} onChange={(e) => set('fontSize', Number(e.target.value))} />
          </label>
          <label className="field">
            <span>기억할 줄 수</span>
            <input
              type="number"
              min={100}
              max={200000}
              value={form.scrollback}
              onChange={(e) => set('scrollback', Number(e.target.value))}
              onBlur={(e) => set('scrollback', Math.min(200000, Math.max(100, Number(e.target.value) || DEFAULT_SETTINGS.scrollback)))}
            />
          </label>

          <label className="field span2">
            <span>터미널 색</span>
            <select value={form.terminalTheme} onChange={(e) => set('terminalTheme', e.target.value as Settings['terminalTheme'])}>
              {Object.entries(TERMINAL_THEMES).map(([key, v]) => (
                <option key={key} value={key}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field span2">
            <span>앱 화면</span>
            <select value={form.appTheme} onChange={(e) => set('appTheme', e.target.value as Settings['appTheme'])}>
              <option value="light">밝게</option>
              <option value="dark">어둡게</option>
            </select>
          </label>

          <label className="field span2">
            <span>커서 모양</span>
            <select value={form.cursorStyle} onChange={(e) => set('cursorStyle', e.target.value as Settings['cursorStyle'])}>
              <option value="block">네모</option>
              <option value="bar">막대</option>
              <option value="underline">밑줄</option>
            </select>
          </label>
          <label className="check span2">
            <input type="checkbox" checked={form.cursorBlink} onChange={(e) => set('cursorBlink', e.target.checked)} />
            커서 깜빡임
          </label>

          <label className="check span4">
            <input type="checkbox" checked={form.ctrlVPaste} onChange={(e) => set('ctrlVPaste', e.target.checked)} />
            Ctrl+V로 붙여넣기 (끄면 셸에 그대로 전달됩니다. Ctrl+Shift+V는 항상 붙여넣기)
          </label>

          <div className="field span4">
            <span>미리 보기</span>
            <pre
              className="settings-preview"
              style={{ background: theme.background, color: theme.foreground, fontFamily: form.fontFamily, fontSize: form.fontSize }}
            >
              {'$ ls -al  한글 출력 확인\ndrwxr-xr-x  2 root root  4096  9월 21 10:00 .'}
            </pre>
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={() => setForm(DEFAULT_SETTINGS)}>
            기본값으로
          </button>
          <button type="button" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="primary">
            저장
          </button>
        </div>
      </form>
    </div>
  )
}
