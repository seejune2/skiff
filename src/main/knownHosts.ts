import { createHash } from 'node:crypto'
import { readJson, writeJson } from './jsonFile'

interface KnownHost {
  keyType: string
  fingerprint: string
}

interface KnownHostsFile {
  version: 1
  hosts: Record<string, KnownHost>
}

/** OpenSSH와 같은 형식: SHA256:base64(패딩 없음) */
export function fingerprint(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

/** SSH 공개키 blob의 첫 문자열이 키 종류다. */
export function keyType(key: Buffer): string {
  if (key.length < 4) return 'unknown'
  const len = key.readUInt32BE(0)
  return len > 0 && len < 64 && key.length >= 4 + len ? key.toString('ascii', 4, 4 + len) : 'unknown'
}

export class KnownHosts {
  constructor(private readonly path: string) {}

  private load(): KnownHostsFile {
    return readJson<KnownHostsFile>(this.path, { version: 1, hosts: {} })
  }

  get(host: string, port: number): KnownHost | undefined {
    return this.load().hosts[`${host.toLowerCase()}:${port}`]
  }

  set(host: string, port: number, entry: KnownHost): void {
    const data = this.load()
    data.hosts[`${host.toLowerCase()}:${port}`] = entry
    writeJson(this.path, data)
  }
}
