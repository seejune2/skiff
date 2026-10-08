import { expect, it } from 'vitest'
import { buildTree } from '../src/renderer/src/Sidebar'
import { validateSession } from '../src/main/sessions'
import type { Session } from '../src/shared/types'

const s = (name: string, group: string) => ({ id: name, name, group }) as Session

it('그룹 이름의 /를 하위 그룹으로 나누고, 기본이 맨 앞, 개수는 하위까지 합친다', () => {
  const tree = buildTree([s('w2', '서버/웹'), s('w1', '서버/웹'), s('db', '서버/DB'), s('top', '서버'), s('none', '')])
  expect(tree.map((n) => n.path)).toEqual(['기본', '서버'])
  const server = tree[1]
  expect(server.count).toBe(4)
  expect(server.sessions.map((x) => x.name)).toEqual(['top'])
  expect(server.children.map((n) => [n.path, n.count])).toEqual([['서버/웹', 2], ['서버/DB', 1]])
  expect(server.children[0].sessions.map((x) => x.name)).toEqual(['w1', 'w2'])
})

it('저장할 때 그룹 경로의 공백과 빈 단계를 없앤다', () => {
  const base = { host: 'h', port: 22, username: 'u', authType: 'password', privateKeyPath: '' }
  expect(validateSession({ ...base, group: ' 서버 / /웹/ ' }).group).toBe('서버/웹')
})
