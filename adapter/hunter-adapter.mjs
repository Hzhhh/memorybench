// hunter-adapter.mjs — MemoryBench 冲榜专用适配器（进程内全流程）
// ====================================================================
// 流水线：LLM 查询分解 → 多查询 [BM25 + 网关稠密] RRF 融合 → 网关 rerank → top-10
// 设计：
//   - 工厂导出：isolate=true 每题全新状态（题间天然隔离）
//   - write 仅缓冲；首个 retrieve 时一次性建 BM25 索引 + 批量向量（并行）
//   - 全链路降级：LLM 失败→单查询；embedding 失败→纯 BM25；rerank 失败→融合序
// 环境开关：
//   MB_DECOMP=1    LLM 查询分解（默认开）
//   MB_DENSE=1     稠密通道（默认开）
//   MB_RERANK=1    重排（默认开）
//   MB_POOL=50     重排候选池大小
//   MB_CAND=30     每查询每通道取前 N
//   MB_W_BM25 / MB_W_DENSE   RRF 权重（默认 1/1）
import { UnsupportedError } from '@mtlopenyc/contract'
import { BM25, tokenize } from '../lib/bm25.mjs'
import { embed, rerank } from '../lib/gateway.mjs'
import { decompose } from '../lib/query.mjs'

const DECOMP = process.env.MB_DECOMP !== '0'
const DENSE = process.env.MB_DENSE !== '0'
const RERANK = process.env.MB_RERANK !== '0'
const POOL = Number(process.env.MB_POOL ?? 50)
const CAND = Number(process.env.MB_CAND ?? 30)
const W_BM25 = Number(process.env.MB_W_BM25 ?? 1)
const W_DENSE = Number(process.env.MB_W_DENSE ?? 1)
const RRF_K = 60

let counter = 0

function makeAdapter() {
  const tag = `hunter-${(counter++).toString(36)}`
  const turns = [] // {id, role, content, sessionId}
  let pending = null
  let indexed = null // {bm25, docVecs: Float32Array[]}

  async function flushPending() {
    if (pending) {
      for (const m of pending.msgs) {
        turns.push({ id: m.id, role: m.role, content: m.content, sessionId: pending.sessionId })
      }
      pending = null
    }
  }

  async function ensureIndex() {
    if (indexed || !turns.length) return
    const bm25 = new BM25(turns.map(t => tokenize(t.content)))
    let docVecs = null
    if (DENSE) {
      try {
        docVecs = await embed(turns.map(t => t.content))
        if (docVecs.length !== turns.length) docVecs = null
      } catch (e) {
        console.error(`[${tag}] embed failed:`, e.message)
        docVecs = null
      }
    }
    indexed = { bm25, docVecs }
  }

  function denseTop(queryVec, k) {
    const { docVecs } = indexed
    if (!docVecs) return []
    const scored = []
    for (let i = 0; i < docVecs.length; i++) {
      const v = docVecs[i]
      let s = 0
      for (let j = 0; j < v.length; j++) s += v[j] * queryVec[j]
      scored.push({ idx: i, score: s })
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, k)
  }

  return {
    id: 'hunter',
    description: 'MemoryBench 冲榜系统：LLM查询分解 + BM25/稠密多查询RRF + 交叉重排',

    async write(input) {
      const meta = input.metadata ?? {}
      const sessionId = meta.sessionId ?? `s${meta.sessionIdx ?? 0}`
      if (pending && pending.sessionId !== sessionId) await flushPending()
      if (!pending) pending = { sessionId, msgs: [] }
      pending.msgs.push({
        id: String(input.id),
        role: String(meta.role ?? 'user'),
        content: String(input.content ?? ''),
      })
      return {
        id: String(input.id),
        content: String(input.content ?? ''),
        userId: input.userId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    },

    async retrieve(query, opts) {
      await flushPending()
      await ensureIndex()
      const topK = opts?.topK ?? 10
      if (!turns.length) return { records: [] }

      // 1) 查询分解（含原查询）
      const queries = DECOMP ? await decompose(query) : [query]

      // 2) 多查询 × 双通道 RRF 融合
      let qVec = null
      if (DENSE && indexed.docVecs) {
        try {
          const [v] = await embed([query])
          qVec = v
        } catch { qVec = null }
      }
      const fused = new Map() // idx -> score
      const rankAdd = (list, weight) => {
        list.forEach((item, r) => {
          fused.set(item.idx, (fused.get(item.idx) ?? 0) + weight / (RRF_K + r + 1))
        })
      }
      for (const q of queries) {
        const toks = tokenize(q)
        if (toks.length) rankAdd(indexed.bm25.topK(toks, CAND), W_BM25)
      }
      if (qVec) rankAdd(denseTop(qVec, CAND), W_DENSE)

      const candidates = [...fused.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.max(POOL, topK))
        .map(([idx]) => idx)
      if (!candidates.length) return { records: [] }

      // 3) 重排（用原始问题）
      let finalOrder = candidates
      if (RERANK && candidates.length > 1) {
        const rr = await rerank(query, candidates.map(i => turns[i].content))
        if (rr && rr.length) {
          const byIdx = new Map(rr.map(r => [r.index, r.score]))
          finalOrder = candidates
            .map((idx, i) => [idx, byIdx.get(i) ?? -1e9])
            .sort((a, b) => b[1] - a[1])
            .map(x => x[0])
        }
      }

      // 4) topK 输出
      const records = finalOrder.slice(0, topK).map(idx => ({
        id: turns[idx].id,
        content: turns[idx].content,
      }))
      return { records, scores: records.map(() => 1) }
    },

    // —— 审计组：不支持 ——
    async enumerate() { throw new UnsupportedError('enumerate') },
    async provenance() { throw new UnsupportedError('provenance') },
    async subjectLookup() { throw new UnsupportedError('subject_lookup') },
    async delete() { throw new UnsupportedError('delete') },
    async export() { throw new UnsupportedError('export') },
    async mutationHistory() { throw new UnsupportedError('mutation_history') },
    async telemetry() { return [] },
  }
}

export default makeAdapter
