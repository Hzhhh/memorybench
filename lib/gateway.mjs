// gateway.mjs — 海致 LLM 网关客户端（embedding / rerank / chat）
const BASE = process.env.MB_GW_BASE ?? 'http://llm.demo.haizhi.com'
const EMB_MODEL = process.env.MB_EMB_MODEL ?? 'text-embedding-v4'
const RERANK_MODEL = process.env.MB_RERANK_MODEL ?? 'bge-reranker-v2-m3'
const CHAT_MODEL = process.env.MB_CHAT_MODEL ?? 'deepseek-v4-flash-0731'
const WORKERS = Number(process.env.MB_GW_WORKERS ?? 8)

async function postJson(path, body, timeoutMs = 120000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`)
    return await res.json()
  } finally {
    clearTimeout(t)
  }
}

/** 批量向量（L2 归一化），返回 Float32Array 数组；失败返回 null */
export async function embed(texts) {
  if (!texts.length) return []
  const chunks = []
  for (let i = 0; i < texts.length; i += 64) chunks.push(texts.slice(i, i + 64))
  const enc = async (chunk) => {
    const d = await postJson('/v1/embeddings', { model: EMB_MODEL, input: chunk })
    return d.data.sort((a, b) => a.index - b.index).map(x => x.embedding)
  }
  const parts = await Promise.all(chunks.map((c, i) => (i < WORKERS ? enc(c) : enc(c))))
  const vecs = parts.flat().map(v => {
    const a = Float32Array.from(v)
    let n = 0
    for (const x of a) n += x * x
    n = Math.sqrt(n) || 1
    for (let i = 0; i < a.length; i++) a[i] /= n
    return a
  })
  return vecs
}

/** rerank：返回按相关性降序的 [{index, score}]；失败返回 null */
export async function rerank(query, documents) {
  try {
    const d = await postJson('/v1/rerank', { model: RERANK_MODEL, query, documents })
    return d.results
      .map(r => ({ index: r.index, score: r.relevance_score }))
      .sort((a, b) => b.score - a.score)
  } catch (e) {
    console.error('[rerank] failed:', e.message)
    return null
  }
}

/** chat：返回文本；失败重试 1 次，再失败返回 null */
export async function chat(messages, { temperature = 0, timeoutMs = 90000 } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const d = await postJson('/v1/chat/completions', { model: CHAT_MODEL, messages, temperature }, timeoutMs)
      return d.choices[0].message.content
    } catch (e) {
      if (attempt === 1) console.error('[chat] failed x2:', e.message)
    }
  }
  return null
}
