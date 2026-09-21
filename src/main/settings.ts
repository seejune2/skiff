import { DEFAULT_SETTINGS, type Settings } from '../shared/types'
import { readJson, writeJson } from './jsonFile'

const clamp = (n: unknown, min: number, max: number, fallback: number) =>
  Number.isFinite(Number(n)) ? Math.min(max, Math.max(min, Math.round(Number(n)))) : fallback

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback

/** renderer가 보낸 값을 다시 검증한다. 이상한 값은 기본값으로 돌린다. */
export function validateSettings(input: unknown): Settings {
  const o = (input ?? {}) as Record<string, unknown>
  return {
    fontFamily: typeof o.fontFamily === 'string' && o.fontFamily.trim() ? o.fontFamily.slice(0, 200) : DEFAULT_SETTINGS.fontFamily,
    fontSize: clamp(o.fontSize, 8, 40, DEFAULT_SETTINGS.fontSize),
    terminalTheme: pick(o.terminalTheme, ['dark', 'light', 'solarized'] as const, DEFAULT_SETTINGS.terminalTheme),
    appTheme: pick(o.appTheme, ['light', 'dark'] as const, DEFAULT_SETTINGS.appTheme),
    scrollback: clamp(o.scrollback, 100, 200000, DEFAULT_SETTINGS.scrollback),
    cursorStyle: pick(o.cursorStyle, ['block', 'bar', 'underline'] as const, DEFAULT_SETTINGS.cursorStyle),
    cursorBlink: o.cursorBlink !== false,
    ctrlVPaste: o.ctrlVPaste === true
  }
}

export class SettingsStore {
  constructor(private readonly path: string) {}

  get(): Settings {
    return validateSettings(readJson<{ version: 1; settings: Settings }>(this.path, { version: 1, settings: DEFAULT_SETTINGS }).settings)
  }

  save(input: unknown): Settings {
    const settings = validateSettings(input)
    writeJson(this.path, { version: 1, settings })
    return settings
  }
}
