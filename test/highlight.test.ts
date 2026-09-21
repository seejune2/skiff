import { expect, it } from 'vitest'
import { Highlighter } from '../src/renderer/src/highlight'

it('키워드에 색을 입히되 서버 색, 이스케이프, 전체 화면 프로그램은 건드리지 않는다', () => {
  const h = new Highlighter()
  expect(h.process('etcd True False not ready 10.0.1.111:22')).toBe(
    'etcd \x1b[92mTrue\x1b[39m \x1b[91mFalse\x1b[39m \x1b[91mnot ready\x1b[39m \x1b[96m10.0.1.111:22\x1b[39m'
  )
  expect(h.process('\x1b[01;34merror\x1b[0m error')).toBe('\x1b[01;34merror\x1b[0m \x1b[91merror\x1b[39m')
  // 청크 경계에서 잘린 이스케이프
  expect(h.process('a\x1b[3')).toBe('a')
  expect(h.process('1mfail\x1b[m')).toBe('\x1b[31mfail\x1b[m')
  // 대체 화면(vim 등)
  expect(h.process('\x1b[?1049herror')).toBe('\x1b[?1049herror')
  expect(h.process('\x1b[?1049lerror')).toBe('\x1b[?1049l\x1b[91merror\x1b[39m')
})

import { stripAnsi } from '../src/main/logs'

it('로그에는 제어 문자를 뺀 글자만 남긴다', () => {
  expect(stripAnsi('\x1b[32m초록\x1b[0m\r\n진행 10%\r진행 20%\x07\r\n\x1b]0;title\x07끝')).toBe('초록\n진행 10%진행 20%\n끝')
})

import { validateSettings } from '../src/main/settings'
import { DEFAULT_SETTINGS } from '../src/shared/types'

it('설정값을 검증해 이상한 값은 기본값이나 범위 안으로 돌린다', () => {
  expect(validateSettings({})).toEqual(DEFAULT_SETTINGS)
  expect(validateSettings({ fontSize: 999, scrollback: 5, terminalTheme: '해킹', appTheme: 'dark', ctrlVPaste: true })).toMatchObject({
    fontSize: 40,
    scrollback: 100,
    terminalTheme: 'dark',
    appTheme: 'dark',
    ctrlVPaste: true
  })
  expect(validateSettings({ fontFamily: '   ' }).fontFamily).toBe(DEFAULT_SETTINGS.fontFamily)
})
