// offline-score.mjs — 离线全量打分器（确定性层，秒级跑完 500 题）
// 复刻 hunter-adapter 的 BM25 路线（不含 LLM 选证），分解结果走缓存
// 用法: node scripts/offline-score.mjs k1=1.5 b=0.75 t0=0.8 wbm25=1 quota=enumeration role=0.3 update=1 cand=30 pool=50 t0mode=v5
import { readFileSync } from 'node:fs'
import { BM25, tokenize } from '../lib/bm25.mjs'
import { findLatestUpdateTurn } from '../lib/update.mjs'

const DATA = process.env.MB_DATA_DIR ?? 'E:/memorybench/memory-bench/packages/evaluation/src/benchmarks/data/'
const CACHE = process.env.MB_CACHE ?? 'E:/memorybench/hunter/cache/decompose-cache.json'
const HYDE_CACHE = process.env.MB_HYDE_CACHE ?? 'E:/memorybench/hunter/cache/hyde-cache.json'
const ATA_CACHE = process.env.MB_ATA_CACHE ?? 'E:/memorybench/hunter/cache/ata-cache.json'

// ---- 参数 ----
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.split('=')
  return [k, v === undefined ? true : (isNaN(Number(v)) ? v : Number(v))]
}))
const P = {
  k1: args.k1 ?? 1.5,
  b: args.b ?? 0.75,
  t0: args.t0 ?? 0.8,
  wbm25: args.wbm25 ?? 1,
  quota: String(args.quota ?? 'enumeration'),
  role: args.role ?? 0.3,
  update: args.update ?? 1,
  cand: args.cand ?? 30,
  pool: args.pool ?? 50,
  t0mode: String(args.t0mode ?? 'v5'), // v5=分类temporal或single+regex; broad=任意regex
  hyde: args.hyde ?? 0,   // 1=把缓存中的假设证据文本作为额外 BM25 查询
  ata: args.ata ?? 0,     // 1=用缓存的"先答后选"结果重排 top-10
}

import { existsSync } from 'node:fs'
const hydeCache = P.hyde && existsSync(HYDE_CACHE) ? JSON.parse(readFileSync(HYDE_CACHE, 'utf8')) : {}
const ataCache = P.ata && existsSync(ATA_CACHE) ? JSON.parse(readFileSync(ATA_CACHE, 'utf8')) : {}

const CHRONO_RE = /order|chronolog|sequence|first|last|latest|earliest|before|after|recent|history|timeline|when did/i
const ASSISTANT_RE = /\b(you|your|assistant)\b[^.?]*\b(recommend|suggest|say|said|mention|advise|propose|think)\b|\b(recommend|suggest|advise|propose)d?\b[^.?]*\b(you|assistant)\b/i

const cache = JSON.parse(readFileSync(CACHE, 'utf8'))

// ---- 数据加载与复用（同名 session 前缀过滤）----
function loadSet(file) {
  return JSON.parse(readFileSync(DATA + file, 'utf8'))
}

function scenarioOf(r) {
  const sessions = r.haystack_sessions ?? []
  const turns = []
  sessions.forEach((s, si) => s.forEach((t, ti) => {
    turns.push({
      id: `${r.question_id}#s${si}#t${ti}`,
      role: t.role ?? 'user',
      content: t.content,
      sessionId: r.haystack_session_ids?.[si] ?? `s${si}`,
      sessionIdx: si,
      turnIdx: ti,
    })
  }))
  let relevantIds = []
  sessions.forEach((s, si) => s.forEach((t, ti) => { if (t.has_answer === true) relevantIds.push(`${r.question_id}#s${si}#t${ti}`) }))
  if (relevantIds.length === 0) {
    const ans = new Set(r.answer_session_ids ?? [])
    sessions.forEach((s, si) => {
      if (ans.has(r.haystack_session_ids?.[si])) s.forEach((_, ti) => relevantIds.push(`${r.question_id}#s${si}#t${ti}`))
    })
  }
  return { qid: r.question_id, q: r.question, turns, relevantIds }
}

// ---- 检索管线（与 adapter 一致）----
function retrieve(sc, dec) {
  const { turns } = sc
  if (!turns.length) return []
  const bm25 = new BM25(turns.map(t => tokenize(t.content)), { k1: P.k1, b: P.b })
  const queries = dec?.queries ?? [sc.q]
  const qtype = dec?.type ?? 'single'
  const allQueries = P.hyde ? [...queries, ...(hydeCache[sc.qid] ?? [])] : queries

  const fused = new Map()
  const rankAdd = (list, weight) => list.forEach((item, r) => {
    fused.set(item.idx, (fused.get(item.idx) ?? 0) + weight / (60 + r + 1))
  })
  for (const q of allQueries) {
    const toks = tokenize(q)
    if (toks.length) rankAdd(bm25.topK(toks, P.cand), P.wbm25)
  }
  // t0 先验
  const chronoHit = P.t0mode === 'broad' ? CHRONO_RE.test(sc.q) : CHRONO_RE.test(sc.q)
  const t0Fire = P.t0 > 0 && (P.t0mode === 'broad'
    ? (qtype === 'temporal' || chronoHit)
    : (qtype === 'temporal' || (qtype === 'single' && chronoHit)))
  if (t0Fire) {
    for (const [idx, s] of fused) if (turns[idx].turnIdx === 0) fused.set(idx, s * (1 + P.t0))
  }
  // 角色先验
  if (P.role > 0 && ASSISTANT_RE.test(sc.q)) {
    for (const [idx, s] of fused) if (turns[idx].role === 'assistant') fused.set(idx, s * (1 + P.role))
  }

  let candidates = [...fused.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, Math.max(P.pool, 10)).map(([i]) => i)
  // session 配额
  if (P.quota.split(',').includes(qtype)) {
    const per = new Map(), seen = new Set(), head = [], tail = []
    for (const idx of candidates) {
      if (seen.has(idx)) continue
      seen.add(idx)
      const sid = turns[idx].sessionId
      const used = per.get(sid) ?? 0
      if (used < 2) { head.push(idx); per.set(sid, used + 1) } else tail.push(idx)
    }
    candidates = [...head, ...tail]
  }
  // update 置顶
  if (qtype === 'update' && P.update) {
    const li = findLatestUpdateTurn(sc.q, turns)
    if (li !== null) candidates = [li, ...candidates.filter(i => i !== li)]
  }
  // ATA(先答后选)重排: 缓存的 picks 是 turns 数组索引
  if (P.ata && ataCache[sc.qid]?.length) {
    const picked = ataCache[sc.qid]
    const pickedSet = new Set(picked)
    candidates = [...picked, ...candidates.filter(i => !pickedSet.has(i))]
  }
  return candidates.slice(0, 10)
}

// ---- 指标 ----
function metrics(retrievedIds, relevantIds) {
  const rel = new Set(relevantIds)
  if (rel.size === 0) return { r5: 1, n10: 0 }
  const r5 = retrievedIds.slice(0, 5).filter(id => rel.has(id)).length / rel.size
  const dcg = retrievedIds.slice(0, 10).reduce((s, id, i) => s + (rel.has(id) ? 1 / Math.log2(i + 2) : 0), 0)
  const idcg = [...Array(Math.min(10, rel.size))].reduce((s, _, i) => s + 1 / Math.log2(i + 2), 0)
  return { r5, n10: idcg ? dcg / idcg : 0 }
}

// ---- 主流程 ----
function runSet(name, records) {
  let r5s = 0, n10s = 0, n = 0
  const byType = {}
  for (const r of records) {
    const sc = scenarioOf(r)
    const dec = cache[sc.qid]
    const got = retrieve(sc, dec).map(i => sc.turns[i].id)
    const m = metrics(got, sc.relevantIds)
    r5s += m.r5; n10s += m.n10; n++
    const t = byType[r.question_type ?? '?'] ??= { n: 0, s: 0 }
    t.n++; t.s += (m.r5 + m.n10) / 2
  }
  const comp = (r5s + n10s) / 2 / n
  console.log(`${name}: n=${n} r5=${(r5s / n).toFixed(4)} n10=${(n10s / n).toFixed(4)} comp=${comp.toFixed(4)}`)
  return { n, r5: r5s / n, n10: n10s / n, comp, byType }
}

const pub = runSet('public ', loadSet('longmemeval-public.json'))
const hold = runSet('holdout', loadSet('longmemeval-holdout.json'))
const combinedComp = (pub.comp * pub.n + hold.comp * hold.n) / (pub.n + hold.n)
console.log(`combined comp = ${combinedComp.toFixed(4)}`)
if (args.types) {
  for (const [t, v] of Object.entries(pub.byType)) {
    const h = hold.byType[t] ?? { n: 0, s: 0 }
    console.log(`  ${t}: pub=${(v.s / v.n).toFixed(3)}(n=${v.n}) hold=${(h.s / h.n).toFixed(3)}(n=${h.n})`)
  }
}
