// 增量分句器:LLM 流式 delta 进、完整句子出,供逐句 TTS 合成(首句边流边说)。
// 纯函数模块,行为矩阵进 CI(tests/sentenceSplitter.test.mjs)。
//
// 断句规则(语音回复是口语短句,规则从简):
//   · 句末标点(。!?…;:)与换行即断;
//   · 缓冲超过 24 字后在逗号/顿号处让步断句(长气口拆短,降低首句延迟);
//   · 60 字硬顶强断(防 LLM 不打标点时 TTS 饿死);
//   · 英文句点不作为断点(3.14 / Mr. 误伤大于收益),英文长句靠硬顶兜底。
// 切出的句子 trim;空白 delta 不产句。

const SOFT_LIMIT = 24
const HARD_LIMIT = 60
const TERMINATORS = new Set(['。', '!', '?', '…', ';', '；', ':', '：', '\n'])
const SOFT_BREAKS = new Set([',', ',', ',', ';', '；'])

export interface SentenceSplitter {
  /** 喂一段增量,返回本次切出的完整句子(可能为空数组) */
  feed(delta: string): string[]
  /** 流结束:把剩余缓冲作为最后一句交出(可为空串) */
  flush(): string
}

export function createSentenceSplitter(): SentenceSplitter {
  let buf = ''
  const push = (out: string[], s: string) => {
    const t = s.trim()
    if (t) out.push(t)
  }
  return {
    feed(delta) {
      const out: string[] = []
      for (const ch of delta) {
        if (TERMINATORS.has(ch)) {
          // 句末标点保留进句子(TTS 依标点定语调);换行只断句不带出
          if (ch !== '\n') buf += ch
          push(out, buf)
          buf = ''
          continue
        }
        buf += ch
        if (buf.length >= HARD_LIMIT) {
          push(out, buf)
          buf = ''
          continue
        }
        if (buf.length >= SOFT_LIMIT && SOFT_BREAKS.has(ch)) {
          push(out, buf)
          buf = ''
        }
      }
      return out
    },
    flush() {
      const t = buf.trim()
      buf = ''
      return t
    },
  }
}
