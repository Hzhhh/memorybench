// query.mjs — LLM 查询分类+分解：问题 → {type, queries[]}（带缓存）
// type: temporal(时序) | enumeration(枚举计数) | update(值更新) | single(单事实)
import { chat } from './gateway.mjs'

const cache = new Map()

const PROMPT = (q) =>
  'You are building search queries to retrieve conversation turns from a personal-assistant chat history. ' +
  'First classify the question:\n' +
  '- "enumeration": asks to COUNT/LIST/TOTAL multiple items of a category across the history (how many / which / list all / total)\n' +
  '- "temporal": asks about ORDER/dates/first/latest/chronology of specific things\n' +
  '- "update": asks for the CURRENT/latest value of something that may have changed\n' +
  '- "single": a single fact, preference, or event\n\n' +
  'Then write evidence-style search queries. Rules:\n' +
  '- Each query is a short declarative phrase matching a conversation turn CONTAINING evidence (never a question or how-to).\n' +
  '- Resolve pronouns to specifics when inferable.\n' +
  '- For enumeration: write 3-6 CATEGORY-DEFINING queries with synonyms spread across queries (e.g. "visited museum gallery exhibition", "went to art show") — instances are scattered across sessions, each query should surface a different slice.\n' +
  '- For temporal: include the topic entities and time words; one query per time point if distinct events are asked.\n' +
  '- Others: 1-3 queries. Keep each query under 15 words.\n\n' +
  'Return ONLY JSON: {"type":"enumeration|temporal|update|single","queries":["..."]} no other text.\n\n' +
  `Question: ${q}`

/** 返回 {type, queries: [原问题, ...子查询]}；失败退化为 {type:'single', queries:[原问题]} */
export async function decompose(question) {
  if (cache.has(question)) return cache.get(question)
  let out = { type: 'single', queries: [question] }
  const raw = await chat([{ role: 'user', content: PROMPT(question) }])
  if (raw) {
    try {
      const m = raw.match(/\{[\s\S]*\}/)
      if (m) {
        const obj = JSON.parse(m[0])
        const t = ['enumeration', 'temporal', 'update', 'single'].includes(obj.type) ? obj.type : 'single'
        const subs = Array.isArray(obj.queries)
          ? obj.queries.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()).slice(0, 6)
          : []
        if (subs.length) out = { type: t, queries: [question, ...subs] }
        else out = { type: t, queries: [question] }
      }
    } catch { /* 退化 */ }
  }
  cache.set(question, out)
  return out
}
