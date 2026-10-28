// build-cache.mjs — 一次性缓存 500 题的 LLM 分解结果（离线实验引擎的 LLM 层）
// 用法: node scripts/build-cache.mjs [并发数]
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { decompose } from '../lib/query.mjs'

const dir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const DATA = process.env.MB_DATA_DIR ?? 'E:/memorybench/memory-bench/packages/evaluation/src/benchmarks/data/'
const OUT = process.env.MB_CACHE ?? 'E:/memorybench/hunter/cache/decompose-cache.json'
const CONCURRENCY = Number(process.argv[2] ?? 8)

const questions = []
for (const f of ['longmemeval-public.json', 'longmemeval-holdout.json']) {
  for (const r of JSON.parse(readFileSync(DATA + f, 'utf8'))) {
    questions.push({ qid: r.question_id, q: r.question, type: r.question_type ?? '?' })
  }
}

// 断点续跑：已有缓存的不重调
const cache = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {}
let done = 0, failed = 0
const todo = questions.filter(x => !cache[x.qid])
console.log(`总题数 ${questions.length}，已缓存 ${Object.keys(cache).length}，待跑 ${todo.length}`)

async function worker(id, queue) {
  while (queue.length) {
    const item = queue.shift()
    if (!item) break
    try {
      const dec = await decompose(item.q)
      cache[item.qid] = dec
    } catch (e) {
      failed++
      console.error(`[w${id}] ${item.qid} failed: ${e.message}`)
    }
    done++
    if (done % 20 === 0) {
      console.log(`进度 ${done}/${todo.length} (fail ${failed})`)
      writeFileSync(OUT, JSON.stringify(cache)) // 周期性落盘
    }
  }
}

const queue = [...todo]
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i, queue)))
writeFileSync(OUT, JSON.stringify(cache, null, 1))
console.log(`完成: ${Object.keys(cache).length} 条缓存 (本轮失败 ${failed})`)
