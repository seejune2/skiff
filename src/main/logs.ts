import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

/** 로그에는 읽을 글자만 남긴다: 이스케이프 시퀀스 제거, CRLF → LF, 줄 중간의 CR과 벨 제거 */
export const stripAnsi = (s: string) =>
  s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[\r\x07]/g, '')

export class SessionLogs {
  private readonly files = new Map<string, { stream: WriteStream; decoder: StringDecoder; path: string }>()

  constructor(private readonly dir: string) {}

  /** 로그 파일 경로를 돌려준다. */
  start(connId: string, name: string): string {
    const existing = this.files.get(connId)
    if (existing) return existing.path
    mkdirSync(this.dir, { recursive: true })
    const d = new Date()
    const p2 = (n: number) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`
    const path = join(this.dir, `${name.replace(/[\\/:*?"<>|\s]+/g, '_')}_${stamp}.log`)
    this.files.set(connId, { stream: createWriteStream(path, { flags: 'a' }), decoder: new StringDecoder('utf8'), path })
    return path
  }

  write(connId: string, data: Uint8Array): void {
    const f = this.files.get(connId)
    if (f) f.stream.write(stripAnsi(f.decoder.write(Buffer.from(data))))
  }

  stop(connId: string): void {
    const f = this.files.get(connId)
    if (!f) return
    f.stream.end(stripAnsi(f.decoder.end()))
    this.files.delete(connId)
  }
}
