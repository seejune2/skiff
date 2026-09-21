import { expect, it } from 'vitest'
import { parseSsh } from '../src/renderer/src/quickConnect'

it('ssh 명령을 세션으로 바꾼다', () => {
  expect(parseSsh('ssh root@10.0.1.111')).toMatchObject({ username: 'root', host: '10.0.1.111', port: 22, x11: false })
  expect(parseSsh('ssh -p 2222 -X -i ~/.ssh/id user@host')).toMatchObject({ port: 2222, x11: true, authType: 'key', privateKeyPath: '~/.ssh/id' })
  expect(parseSsh('ssh -l admin host:2200')).toMatchObject({ username: 'admin', host: 'host', port: 2200 })
  const t = parseSsh('ssh -L 8080:db:5432 -R 9000:localhost:3000 -D 1080 a@b')
  expect(typeof t !== 'string' && t.tunnels!.map(({ id: _, ...r }) => r)).toEqual([
    { type: 'local', bindPort: 8080, destHost: 'db', destPort: 5432, autoStart: true },
    { type: 'remote', bindPort: 9000, destHost: 'localhost', destPort: 3000, autoStart: true },
    { type: 'dynamic', bindPort: 1080, destHost: '', destPort: 0, autoStart: true }
  ])
  expect(parseSsh('ssh -L 8080 a@b')).toContain('-L 형식')
  expect(parseSsh('ssh host')).toContain('사용자명')
  expect(parseSsh('ls')).toContain('알 수 없는 명령')
  expect(parseSsh('ssh -o Foo=1 a@b')).toContain('-o')
})

import { parseSshConfig } from '../src/main/sshConfig'

it('ssh config의 Host 블록을 세션으로 바꾼다', () => {
  const list = parseSshConfig(
    [
      '# 주석',
      'Host *',
      '  ServerAliveInterval 60',
      'Host bastion',
      '  HostName 10.0.1.111',
      '  User root',
      '  Port 2222',
      'Host inner',
      '  HostName 192.168.0.5',
      '  User admin',
      '  IdentityFile /keys/id_ed25519',
      '  ForwardX11 yes',
      '  ProxyJump root@bastion:22'
    ].join('\n')
  )
  expect(list.map((s) => s.name)).toEqual(['bastion', 'inner'])
  expect(list[0]).toMatchObject({ host: '10.0.1.111', username: 'root', port: 2222, authType: 'password' })
  expect(list[1]).toMatchObject({ host: '192.168.0.5', authType: 'key', privateKeyPath: '/keys/id_ed25519', x11: true, jumpHostName: 'bastion' })
})
