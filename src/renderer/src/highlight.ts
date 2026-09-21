// MobaXterm처럼 출력 속 키워드에 색을 입힌다. 서버가 직접 색을 준 부분은 건드리지 않는다.
// 한 번에 매칭해야 "not ready"의 ready처럼 겹친 규칙이 두 번 칠해지지 않는다.
const RULE =
  /\b(?:(error|errors|failed|failure|fail|fatal|denied|refused|invalid|degraded|unhealthy|false|not ready|critical)|(warning|warn|deprecated|pending|progressing)|(success|successful|ok|done|true|running|ready|active|enabled|available)|(\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?))\b/gi
const CODES = ['91', '93', '92', '96']
// 완성된 이스케이프 시퀀스(CSI, OSC, 그 외 2바이트)
const ESC = /\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[@-Z\\-_])/g

export class Highlighter {
  private serverColor = false
  /** vim, top 같은 전체 화면 프로그램(대체 화면)에는 색을 입히지 않는다. */
  private altScreen = false
  private pending = ''

  /** 청크 끝에 걸친 미완성 이스케이프는 다음 청크로 넘긴다. */
  // ponytail: 청크 경계에서 잘린 키워드는 색이 안 들어간다. 드물어서 버퍼링하지 않음.
  process(chunk: string): string {
    let text = this.pending + chunk
    this.pending = ''
    const lastEsc = text.lastIndexOf('\x1b')
    if (lastEsc >= 0) {
      ESC.lastIndex = lastEsc
      const m = ESC.exec(text)
      if (!m || m.index !== lastEsc) {
        this.pending = text.slice(lastEsc)
        text = text.slice(0, lastEsc)
      }
    }
    let out = ''
    let pos = 0
    ESC.lastIndex = 0
    for (let m; (m = ESC.exec(text)); ) {
      out += this.color(text.slice(pos, m.index)) + m[0]
      if (m[0].endsWith('m') && m[0][1] === '[') this.trackSgr(m[0].slice(2, -1))
      const alt = /^\x1b\[\?(?:1049|1047|47)([hl])$/.exec(m[0])
      if (alt) this.altScreen = alt[1] === 'h'
      pos = m.index + m[0].length
    }
    return out + this.color(text.slice(pos))
  }

  private color(s: string): string {
    if (!s || this.serverColor || this.altScreen) return s
    return s.replace(RULE, (m, ...groups: (string | undefined)[]) => `\x1b[${CODES[groups.findIndex(Boolean)]}m${m}\x1b[39m`)
  }

  private trackSgr(params: string): void {
    const codes = params === '' ? [0] : params.split(/[;:]/).map(Number)
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]
      if (c === 0 || c === 39) this.serverColor = false
      else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) this.serverColor = true
      else if (c === 38) {
        this.serverColor = true
        i += codes[i + 1] === 5 ? 2 : 4
      } else if (c === 48) i += codes[i + 1] === 5 ? 2 : 4
    }
  }
}
