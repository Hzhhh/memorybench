// bm25.mjs — 极简 BM25Okapi（rank_bm25 同参数：k1=1.5, b=0.75）
const K1 = 1.5
const B = 0.75

export function tokenize(text) {
  return String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 0)
}

export class BM25 {
  constructor(docsTokens) {
    this.docs = docsTokens
    this.N = docsTokens.length
    this.avgdl = docsTokens.reduce((s, d) => s + d.length, 0) / (this.N || 1) || 1
    // df 与 idf
    const df = new Map()
    for (const toks of docsTokens) {
      for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1)
    }
    this.idf = new Map()
    for (const [t, n] of df) {
      // BM25+ idf（rank_bm25 同款，负值抬到 epsilon*avg）
      const v = Math.log(1 + (this.N - n + 0.5) / (n + 0.5))
      this.idf.set(t, v)
    }
    // 每文档词频缓存
    this.tfs = docsTokens.map(toks => {
      const m = new Map()
      for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1)
      return m
    })
  }

  /** 返回全体文档分数（未排序） */
  scores(queryTokens) {
    const out = new Float64Array(this.N)
    for (let i = 0; i < this.N; i++) {
      const tf = this.tfs[i]
      const dl = this.docs[i].length
      const norm = 1 - B + B * (dl / this.avgdl)
      let s = 0
      for (const t of queryTokens) {
        const f = tf.get(t)
        if (!f) continue
        const idf = this.idf.get(t) ?? 0
        s += idf * (f * (K1 + 1)) / (f + K1 * norm)
      }
      out[i] = s
    }
    return out
  }

  /** top-k：返回 [{idx, score}] 降序 */
  topK(queryTokens, k) {
    const sc = this.scores(queryTokens)
    return Array.from(sc.keys())
      .sort((a, b) => sc[b] - sc[a])
      .slice(0, k)
      .map(i => ({ idx: i, score: sc[i] }))
  }
}
