// build-hyde-ata.mjs — 构建 HyDE 假设证据缓存 + ATA(先答后选)缓存
// HyDE: 每题生成假设证据原话（额外 BM25 查询）
// ATA: 基于冻结配置的 top-10，让 LLM 先答题再标注支撑轮
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { chat } from '../lib/gateway.mjs'

const DATA = process.env.MB_DATA_DIR ?? 'E:/memorybench/memory-bench/packages/evaluation/src/benchmarks/data/'
const HYDE_OUT = process.env.MB_HYDE_CACHE ?? 'hyde-cache.json'
const ATA_OUT = process.env.MB_ATA_CACHE ?? 'ata-cache.json'
const CONCURRENCY = Number(process.argv[2] ?? 8)
// 冻结的确定性配置（当前扫参最优）
const K1 = 2.0, B = 0.75, T0 = 1.0

const { BM25, tokenize } = await import('../lib/bm25.mjs')

const questions = []
for (const f of ['longmemeval-public.json', 'longmemeval-holdout.json']) {
  for (const r of JSON.parse(readFileSync(DATA + f, 'utf8'))) {
    const sessions = r.haystack_sessions ?? []
    const turns = []
    sessions.forEach((s, si) => s.forEach((t, ti) => {
      turns.push({ role: t.role ?? 'user', content: t.content, turnIdx: ti })
    }))
    questions.push({ qid: r.question_id, q: r.question, turns })
  }
}

const hyde = existsSync(HYDE_OUT) ? JSON.parse(readFileSync(HYDE_OUT, 'utf8')) : {}
const ata = existsSync(ATA_OUT) ? JSON.parse(readFileSync(ATA_OUT, 'utf8')) : {}

// 冻结配置的 top-10（ATA 的候选池）
function frozenTop10(item, dec) {
  const { turns } = item
  const bm25 = new BM25(turns.map(t => tokenize(t.content)), { k1: K1, b: B })
  const fused = new Map()
  const rankAdd = (list, w) => list.forEach((it, r) => fused.set(it.idx, (fused.get(it.idx) ?? 0) + w / (60 + r + 1)))
  for (const q of dec?.queries ?? [item.q]) {
    const toks = tokenize(q)
    if (toks.length) rankAdd(bm25.topK(toks, 30), 1)
  }
  if (T0 > 0 && /order|chronolog|sequence|first|last|latest|earliest|before|after|recent|history|timeline|when did/i.test(item.q)) {
    for (const [idx, s] of fused) if (turns[idx].turnIdx === 0) fused.set(idx, s * (1 + T0))
  }
  return [...fused.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 10).map(([i]) => i)
}

const HYDE_PROMPT = q =>
  'A question will be asked about a personal-assistant chat history. ' +
  'Write 3 short FIRST-PERSON utterances (as if the user said them in past chats) that would CONTAIN the answer evidence. ' +
  'Use the concrete entities/names/values the answer would mention, conversational tone, each under 20 words.\n' +
  'Return ONLY a JSON array of 3 strings.\n\nQuestion: ' + q

const ATA_PROMPT = (q, numbered) =>
  'Answer the question using ONLY the numbered chat turns below. Then list which turns contain the evidence for your answer.\n' +
  `Question: ${q}\n\nTurns:\n${numbered}\n\n` +
  'Return ONLY JSON: {"answer":"...","evidence":[turn numbers best first]} no other text.'

let done = 0
const queue = questions.filter(x => !hyde[x.qid] || !ata[x.qid])

async function worker(id) {
  while (queue.length) {
    const item = queue.shift()
    if (!item) break
    try {
      if (!hyde[item.qid]) {
        const raw = await chat([{ role: 'user', content: HYDE_PROMPT(item.q) }])
        let out = null
        try { const m = raw?.match(/\[[\s\S]*\]/); if (m) out = JSON.parse(m[0]).filter(x => typeof x === 'string') } catch {}
        hyde[item.qid] = out ?? []
      }
      if (!ata[item.qid]) {
        const top = frozenTop10(item, hyde[item.qid]?.length ? { queries: [item.q, ...hyde[item.qid]] } : null)
        const numbered = top.map((i, n) => `[${n}] ${item.turns[i].role}: ${item.turns[i].content.slice(0, 280)}`).join('\n')
        const raw = await chat([{ role: 'user', content: ATA_PROMPT(item.q, numbered) }])
        let picks = null
        try {
          const m = raw?.match(/\{[\s\S]*\}/)
          if (m) { const o = JSON.parse(m[0]); picks = Array.isArray(o.evidence) ? o.evidence.filter(x => Number.isInteger(x) && x >= 0 && x < top.length).map(x => top[x]) : null }
        } catch {}
        ata[item.qid] = picks ?? []
      }
    } catch (e) { console.error(`[w${id}] ${item.qid}: ${e.message}`) }
    done++
    if (done % 25 === 0) {
      console.log(`进度 ${done}/${queue.length + done}`)
      writeFileSync(HYDE_OUT, JSON.stringify(hyde)); writeFileSync(ATA_OUT, JSON.stringify(ata))
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)))
writeFileSync(HYDE_OUT, JSON.stringify(hyde)); writeFileSync(ATA_OUT, JSON.stringify(ata))
console.log(`完成 hyde=${Object.keys(hyde).length} ata=${Object.keys(ata).length}`)
