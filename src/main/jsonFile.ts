import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 버전이 맞지 않거나 파일이 없으면 fallback을 돌려준다. */
export function readJson<T extends { version: number }>(path: string, fallback: T): T {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    return data?.version === fallback.version ? data : fallback
  } catch {
    return fallback
  }
}

/** 임시 파일에 쓴 뒤 이름을 바꿔 중간에 깨진 파일이 남지 않게 한다. */
export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, path)
}
