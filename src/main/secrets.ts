import { safeStorage } from 'electron'
import { readJson, writeJson } from './jsonFile'

interface SecretFile {
  version: 1
  passwords: Record<string, string>
}

/** safeStorage로 암호화한 비밀번호만 파일에 남긴다. */
export class Secrets {
  constructor(private readonly path: string) {}

  available(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false
    // Linux에서 키링이 없으면 평문과 다름없는 basic_text 백엔드가 선택된다.
    return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
  }

  private load(): SecretFile {
    return readJson<SecretFile>(this.path, { version: 1, passwords: {} })
  }

  has(id: string): boolean {
    return id in this.load().passwords
  }

  get(id: string): string | null {
    const value = this.load().passwords[id]
    if (!value || !this.available()) return null
    try {
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    } catch {
      return null
    }
  }

  save(id: string, password: string): void {
    if (!this.available()) return
    const data = this.load()
    data.passwords[id] = safeStorage.encryptString(password).toString('base64')
    writeJson(this.path, data)
  }

  delete(id: string): void {
    const data = this.load()
    delete data.passwords[id]
    writeJson(this.path, data)
  }
}
