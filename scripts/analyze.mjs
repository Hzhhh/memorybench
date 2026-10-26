// 针对性分析：GT 结构天花板 + 分题型得分 + 错题归因
import { readFileSync } from 'node:fs'

const dir = 'E:/memorybench/memory-bench/packages/evaluation/src/benchmarks/data/'
const pub = JSON.parse(readFileSync(dir + 'longmemeval-public.json', 'utf8'))
const hold = JSON.parse(readFileSync(dir + 'longmemeval-holdout.json', 'utf8'))
const all = new Map()
for (const r of [...pub, ...hold]) {
  const sessions = r.haystack_sessions ?? []
  let rel = 0
  for (const s of sessions) for (const t of s) if (t.has_answer === true) rel++
  let fallback = false
  if (rel === 0) {
    const ans = new Set(r.answer_session_ids ?? [])
    sessions.forEach((s, si) => {
      if (ans.has(r.haystack_session_ids?.[si])) rel += s.length
    })
    fallback = rel > 0
  }
  const turns = sessions.reduce((n, s) => n + s.length, 0)
  all.set(r.question_id, {
    type: r.question_type ?? '?',
    rel, turns, fallback,
    ceilR5: rel === 0 ? 1 : Math.min(5, rel) / rel,
    ceilN10: rel === 0 ? 0 : Math.min(10, rel) >= rel ? 1 : [...Array(10)].reduce((s, _, i) => s + (i < rel ? 1 / Math.log2(i + 2) : 0), 0) / [...Array(Math.min(10, rel))].reduce((s, _, i) => s + 1 / Math.log2(i + 2), 0),
  })
}

// ---- 1) 全局天花板 ----
const stats = [...all.values()]
const ceilR5 = stats.reduce((s, q) => s + q.ceilR5, 0) / stats.length
const ceilN10 = stats.reduce((s, q) => s + q.ceilN10, 0) / stats.length
console.log('════ 1) 理论天花板（500题）════')
console.log('recall@5 上限:', ceilR5.toFixed(4), ' ndcg@10 上限:', ceilN10.toFixed(4), ' 综合上限:', ((ceilR5 + ceilN10) / 2).toFixed(4))

// |rel| 分布
const dist = {}
for (const q of stats) {
  const b = q.rel === 0 ? '0' : q.rel === 1 ? '1' : q.rel <= 3 ? '2-3' : q.rel <= 5 ? '4-5' : q.rel <= 10 ? '6-10' : '11+'
  dist[b] = (dist[b] ?? 0) + 1
}
console.log('|relevant| 分布:', JSON.stringify(dist), '（session回退题数:', stats.filter(q => q.fallback).length + '）')

// ---- 2) 分题型：当前成绩 vs 天花板 ----
const results = [
  ['public-最优', JSON.parse(readFileSync('E:/memorybench/results/ab-noprefix-lex1x.json', 'utf8'))],
  ['holdout-最优', JSON.parse(readFileSync('E:/memorybench/results/atlas-holdout-result.json', 'utf8'))],
]
const perQ = new Map() // qid -> {r5, n10, in10: 命中数/rel}
for (const [, res] of results) {
  for (const qr of res.queryResults) {
    const meta = all.get(qr.queryId)
    const rel = new Set(qr.relevantIds)
    if (rel.size === 0) { perQ.set(qr.queryId, { r5: 1, n10: 0, got: 0, rel: 0 }); continue }
    const hits = (k) => qr.retrievedIds.slice(0, k).filter(id => rel.has(id)).length
    const r5 = hits(5) / rel.size
    const dcg = qr.retrievedIds.slice(0, 10).reduce((s, id, i) => s + (rel.has(id) ? 1 / Math.log2(i + 2) : 0), 0)
    const idcg = [...Array(Math.min(10, rel.size))].reduce((s, _, i) => s + 1 / Math.log2(i + 2), 0)
    perQ.set(qr.queryId, { r5, n10: idcg ? dcg / idcg : 0, got: hits(10), rel: rel.size })
  }
}
console.log('\n════ 2) 分题型 当前 vs 天花板（500题合并）════')
const byType = {}
for (const [qid, s] of perQ) {
  const m = all.get(qid)
  const t = byType[m.type] ??= { n: 0, r5: 0, n10: 0, ceil: 0, r5c: 0, lost: 0 }
  t.n++; t.r5 += s.r5; t.n10 += s.n10; t.ceil += (m.ceilR5 + m.ceilN10) / 2; t.r5c += m.ceilR5
  t.lost += (m.ceilR5 - s.r5) // recall 缺口
}
console.log('题型 | 题数 | recall@5 | ndcg@10 | 综合 | recall@5天花板 | 缺口')
for (const [type, t] of Object.entries(byType).sort((a, b) => b[1].n - a[1].n)) {
  console.log(`${type} | ${t.n} | ${(t.r5 / t.n).toFixed(3)} | ${(t.n10 / t.n).toFixed(3)} | ${((t.r5 + t.n10) / 2 / t.n).toFixed(3)} | ${(t.r5c / t.n).toFixed(3)} | ${(t.lost / t.n).toFixed(3)}`)
}
const tot = Object.values(byType).reduce((a, t) => ({ n: a.n + t.n, r5: a.r5 + t.r5, n10: a.n10 + t.n10, c: a.c + t.ceil }), { n: 0, r5: 0, n10: 0, c: 0 })
console.log(`TOTAL | ${tot.n} | ${(tot.r5 / tot.n).toFixed(4)} | ${(tot.n10 / tot.n).toFixed(4)} | ${((tot.r5 + tot.n10) / 2 / tot.n).toFixed(4)} | — | —`)

// ---- 3) 错题归因：差题的失败模式 ----
console.log('\n════ 3) 失败模式归因（综合分最低的题）════')
const worst = [...perQ.entries()].map(([qid, s]) => ({ qid, ...s, comp: (s.r5 + s.n10) / 2, m: all.get(qid) }))
  .sort((a, b) => a.comp - b.comp)
let notIn10 = 0, in10low = 0, zeroScore = 0
for (const w of worst) {
  if (w.comp === 0) zeroScore++
  if (w.got === 0) notIn10++
}
console.log(`综合=0 的题数: ${zeroScore}/500, top-10 完全未命中(notIn10): ${notIn10}/500`)
console.log('\n最差 15 题样本（qid | 题型 | rel数 | top10命中 | recall@5）:')
for (const w of worst.slice(0, 15)) console.log(`${w.qid.slice(0, 24)} | ${w.m.type} | rel=${w.rel} | hit10=${w.got} | r5=${w.r5.toFixed(2)}`)
