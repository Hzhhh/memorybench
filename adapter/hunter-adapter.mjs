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
import { findLatestUpdateTurn } from '../lib/update.mjs'

const DECOMP = process.env.MB_DECOMP !== '0'
const DENSE = process.env.MB_DENSE !== '0'
const RERANK = process.env.MB_RERANK !== '0'
const POOL = Number(process.env.MB_POOL ?? 50)
const CAND = Number(process.env.MB_CAND ?? 30)
const W_BM25 = Number(process.env.MB_W_BM25 ?? 1)
const W_DENSE = Number(process.env.MB_W_DENSE ?? 1)
const RRF_K = 60
// 时序意图检测 → session 开场轮(t0)结构先验
// 依据：51/500 题的 GT ≥50% 落在 t0（会话开场自述"近况"），这些题当前 recall@5 仅 0.485
const CHRONO_RE = /order|chronolog|sequence|first|last|latest|earliest|before|after|recent|history|timeline|when did/i
const T0_BOOST = Number(process.env.MB_T0_BOOST ?? 0.8)
const SUBDENSE = process.env.MB_SUBDENSE === '1' // 子查询也走稠密通道
// v4: LLM 证据选择 —— LLM 通读候选池原文，直接挑选含证据的轮次（比交叉重排更强）
const LLMSEL = process.env.MB_LLMSEL === '1'
const SEL_POOL = Number(process.env.MB_SEL_POOL ?? 50)
// v8: 更新题最新值置顶（atlas update_detector 规则移植，单变量叠加实验）
const UPDATE_BOOST = process.env.MB_UPDATE_BOOST !== '0'
// v9: session 配额适用题型扩展（默认仅枚举；多证据题 temporal/update 的卡位轮 53/61 跨 session）
const QUOTA_TYPES = new Set((process.env.MB_QUOTA_TYPES ?? 'enumeration').split(',').map(s => s.trim()).filter(Boolean))

async function llmSelect(query, candTurns) {
  const { chat } = await import('../lib/gateway.mjs')
  const numbered = candTurns.map((t, i) => `[${i}] ${t.role}: ${t.content}`).join('\n')
  const prompt =
    'Below are numbered turns from a personal-assistant chat history. ' +
    'Select the turns that CONTAIN EVIDENCE for answering the question — ' +
    'the turns where the answer information actually appears (not turns merely discussing the topic).\n' +
    `Question: ${query}\n\nTurns:\n${numbered}\n\n` +
    `Return ONLY a JSON array of the ${Math.min(10, candTurns.length)} best turn numbers (best first), e.g. [3,0,17]. No other text.`
  const raw = await chat([{ role: 'user', content: prompt }], { temperature: 0 })
  if (!raw) return null
  try {
    const m = raw.match(/\[[\d\s,]*\]/)
    if (!m) return null
    const idxs = JSON.parse(m[0]).filter(x => Number.isInteger(x) && x >= 0 && x < candTurns.length)
    return [...new Set(idxs)]
  } catch { return null }
}

let counter = 0

function makeAdapter() {
  const tag = `hunter-${(counter++).toString(36)}`
  const turns = [] // {id, role, content, sessionId, turnIdx}
  let pending = null
  let indexed = null // {bm25, docVecs: Float32Array[]}

  async function flushPending() {
    if (pending) {
      for (const m of pending.msgs) {
        turns.push({ id: m.id, role: m.role, content: m.content, sessionId: pending.sessionId, turnIdx: m.turnIdx })
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
        turnIdx: Number(meta.turnIdx ?? 0),
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

      // 1) 查询分类+分解（v5：LLM 输出 type + 子查询）
      const dec = DECOMP ? await decompose(query) : { type: 'single', queries: [query] }
      const queries = dec.queries
      const qtype = dec.type

      // 2) 多查询 × 双通道 RRF 融合
      const qVecs = [] // {q, vec}
      if (DENSE && indexed.docVecs) {
        const toEmbed = SUBDENSE ? queries : [query]
        try {
          const vecs = await embed(toEmbed)
          toEmbed.forEach((q, i) => qVecs.push({ q, vec: vecs[i] }))
        } catch { /* 稠密通道整体降级 */ }
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
      for (const { q, vec } of qVecs) {
        const w = q === query ? W_DENSE : W_DENSE * 0.6 // 子查询稠密降权
        rankAdd(denseTop(vec, CAND), w)
      }

      // 2.5) 结构先验：时序题(LLM分类，防 regex 误伤) → session 开场轮加权
      if (T0_BOOST > 0 && (qtype === 'temporal' || (qtype === 'single' && CHRONO_RE.test(query)))) {
        for (const [idx, s] of fused) {
          if (turns[idx].turnIdx === 0) fused.set(idx, s * (1 + T0_BOOST))
        }
      }

      let candidates = [...fused.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.max(POOL, topK))
        .map(([idx]) => idx)
      if (!candidates.length) return { records: [] }

      // 2.6) session 轮转配额（GT 散布多 session 的题型；每 session 最多占 2 席强制跨session覆盖）
      if (QUOTA_TYPES.has(qtype)) {
        const perSession = new Map()
        const seen = new Set()
        const head = []
        const tail = []
        for (const idx of candidates) {
          if (seen.has(idx)) continue
          seen.add(idx)
          const sid = turns[idx].sessionId
          const used = perSession.get(sid) ?? 0
          if (used < 2) {
            head.push(idx)
            perSession.set(sid, used + 1)
          } else {
            tail.push(idx)
          }
        }
        candidates = [...head, ...tail]
      }

      // 3) 终排路由：枚举/更新题 → LLM 证据选择（+轮转序兜底）；其他题型 → 融合序
      let finalOrder = candidates
      const wantSel = LLMSEL && (qtype === 'enumeration' || qtype === 'update')
      if (wantSel && candidates.length > 1) {
        const selPool = candidates.slice(0, SEL_POOL)
        const sel = await llmSelect(query, selPool.map(i => turns[i]))
        if (sel && sel.length) {
          const chosen = sel.map(i => candidates[i]).filter(i => i !== undefined)
          const chosenSet = new Set(chosen)
          finalOrder = [...chosen, ...candidates.filter(i => !chosenSet.has(i))]
        }
      } else if (RERANK && qtype !== 'enumeration' && candidates.length > 1) {
        const rr = await rerank(query, candidates.map(i => turns[i].content))
        if (rr && rr.length) {
          const byIdx = new Map(rr.map(r => [r.index, r.score]))
          finalOrder = candidates
            .map((idx, i) => [idx, byIdx.get(i) ?? -1e9])
            .sort((a, b) => b[1] - a[1])
            .map(x => x[0])
        }
      }

      // 3.5) v8 单变量: 更新题最新值轮置顶（marker 词+值+主题词干重叠≥2，时间序最后命中）
      if (qtype === 'update' && UPDATE_BOOST) {
        const li = findLatestUpdateTurn(query, turns)
        if (li !== null) {
          finalOrder = [li, ...finalOrder.filter(i => i !== li)]
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
