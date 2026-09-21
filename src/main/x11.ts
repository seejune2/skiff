import { connect, type Socket } from 'node:net'
import type { ClientChannel } from 'ssh2'

const PROTOCOL = 'MIT-MAGIC-COOKIE-1'
const pad4 = (n: number) => (n + 3) & ~3

/**
 * X11 접속 첫 패킷에서 인증 정보를 꺼내 가짜 쿠키가 맞는지 확인하고, 인증을 비운 패킷으로 바꾼다.
 * 아직 덜 받았으면 'wait', 쿠키가 틀리면 null.
 */
// ponytail: 로컬 X 서버에는 빈 인증으로 붙는다(VcXsrv 기본 X0.hosts가 localhost 허용). 로컬 쿠키가 필요한 X 서버를 쓰게 되면 여기서 실제 쿠키로 바꾼다.
export function rewriteSetup(buf: Buffer, fakeCookie: Buffer): Buffer | 'wait' | null {
  if (buf.length < 12) return 'wait'
  const big = buf[0] === 0x42
  if (!big && buf[0] !== 0x6c) return null
  const u16 = (o: number) => (big ? buf.readUInt16BE(o) : buf.readUInt16LE(o))
  const nameLen = u16(6)
  const dataLen = u16(8)
  const end = 12 + pad4(nameLen) + pad4(dataLen)
  if (buf.length < end) return 'wait'
  const name = buf.toString('latin1', 12, 12 + nameLen)
  const data = buf.subarray(12 + pad4(nameLen), 12 + pad4(nameLen) + dataLen)
  if (name !== PROTOCOL || !data.equals(fakeCookie)) return null
  const header = Buffer.alloc(12)
  buf.copy(header, 0, 0, 6)
  return Buffer.concat([header, buf.subarray(end)])
}

/** 원격 X11 채널을 로컬 X 서버로 잇는다. */
export function bridgeX11(channel: ClientChannel, fakeCookie: Buffer, port: number): void {
  let pending = Buffer.alloc(0)
  let local: Socket | undefined
  const onData = (d: Buffer) => {
    pending = Buffer.concat([pending, d])
    const setup = rewriteSetup(pending, fakeCookie)
    if (setup === 'wait') return
    channel.off('data', onData)
    channel.pause()
    if (setup === null) return channel.close()
    local = connect(port, '127.0.0.1', () => {
      local!.write(setup)
      channel.pipe(local!).pipe(channel)
    })
    local.on('error', () => channel.close())
  }
  channel.on('data', onData)
  channel.on('close', () => local?.destroy())
}
