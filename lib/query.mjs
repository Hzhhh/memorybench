// query.mjs — LLM 查询分解：问题 → 证据式子查询（带缓存）
import { chat } from './gateway.mjs'

const cache = new Map()

const PROMPT = (q) =>
  'You are building search queries to retrieve conversation turns from a personal-assistant chat history. ' +
  'The turns that contain EVIDENCE for answering the question must be found.\n' +
  'Rewrite the question into 1-4 search queries. Rules:\n' +
  '- Each query is a short declarative phrase that would match (lexically or semantically) a conversation turn CONTAINING the evidence.\n' +
  '- Never write a question, a how-to, or instructions. Write what the evidence utterance itself would talk about.\n' +
  '- Resolve pronouns (I/my/she/he/it) to the concrete person or thing when inferable; keep generic otherwise.\n' +
  '- If the question asks to compare or list multiple distinct items/entities, emit one query per item.\n' +
  '- For time-order questions, include the topic entities and time words (dates, months, "first", "latest", years).\n' +
  '- Keep each query under 15 words.\n' +
  'Return ONLY a JSON array of strings, no other text.\n\n' +
  `Question: ${q}`

/** 返回 [query, ...subqueries]；失败退化为 [原问题] */
export async function decompose(question) {
  if (cache.has(question)) return cache.get(question)
  let out = [question]
  const raw = await chat([{ role: 'user', content: PROMPT(question) }])
  if (raw) {
    try {
      const m = raw.match(/\[[\s\S]*\]/)
      if (m) {
        const arr = JSON.parse(m[0])
        if (Array.isArray(arr)) {
          const subs = arr.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()).slice(0, 4)
          if (subs.length) out = [question, ...subs]
        }
      }
    } catch { /* 退化 */ }
  }
  cache.set(question, out)
  return out
}
