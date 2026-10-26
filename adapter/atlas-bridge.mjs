// atlas-adapter.mjs — MemoryBench ↔ atlas-memory-system (AML) 桥接适配器
// ====================================================================
// 桥接逻辑：
//   - 工厂导出：isolate=true 每题新建实例 → 独立 bucket(user_id) = 天然题间隔离
//   - write：按 session 缓冲 MemoryBench 的逐轮写入，凑齐一个 session 调一次 AML /add
//     （seq 按写入顺序 0,1,2,... 分配 → turnIds[seq] 精确还原 MemoryBench 轮 id）
//   - retrieve：先 flush 缓冲，再 /search；多取 margin 条，过滤注入合成项
//     （conflict-0/timeline-0/persona-0 无真实轮 id），mem-{n}/upd-{n} 映射回轮 id
//   - 时间戳：数据无原生时间 → 按 session 序合成单调时间戳（天粒度 + 轮秒级偏移）
import { UnsupportedError } from '@mtlopenyc/contract'

const BASE = process.env.AML_MB_BASE ?? 'http://127.0.0.1:18000'
const TOKEN = process.env.AML_MB_TOKEN ?? ''
const FETCH_MARGIN = 3 // AML 顶部注入项占位，多取再过滤

let bucketCounter = 0

function makeAdapter() {
  const bucket = `mb-${Date.now().toString(36)}-${(bucketCounter++).toString(36)}`
  const turnIds = [] // seq → MemoryBench 轮 id（写入顺序 = seq 顺序）
  const contents = new Map()
  let pending = null // { sessionId, msgs }

  async function amlPost(path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(TOKEN ? { Authorization: `Token ${TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`AML ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    return res.json()
  }

  async function flush() {
    if (!pending) return
    const { sessionId, msgs } = pending
    pending = null
    if (msgs.length === 0) return
    await amlPost('/add', {
      request_id: `${bucket}-s-${sessionId}`,
      user_id: bucket,
      session_id: String(sessionId),
      messages: msgs,
    })
  }

  return {
    id: 'atlas-memory-system',
    description: 'atlas-memory-system (AML 9.30 参赛配置) via MemoryBench 桥接适配器',

    async write(input) {
      const meta = input.metadata ?? {}
      const sessionId = meta.sessionId ?? `s${meta.sessionIdx ?? 0}`
      if (pending && pending.sessionId !== sessionId) await flush()
      if (!pending) pending = { sessionId, msgs: [] }
      // 数据无原生时间 → 传 null：fmt_date(None)="unknown date" 全库同词（idf≈0），
      // 避免合成假日期进 BM25 索引造成月份词假匹配
      pending.msgs.push({
        role: String(meta.role ?? 'user'),
        content: String(input.content ?? ''),
        timestamp: null,
      })
      turnIds.push(String(input.id))
      contents.set(String(input.id), String(input.content ?? ''))
      return {
        id: String(input.id),
        content: String(input.content ?? ''),
        userId: input.userId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    },

    async retrieve(query, opts) {
      await flush()
      const topK = opts?.topK ?? 10
      const res = await amlPost('/search', {
        query,
        user_id: bucket,
        top_k: topK + FETCH_MARGIN,
      })
      const seen = new Set()
      const records = []
      for (const it of res?.data ?? []) {
        const m = /^(?:mem|upd)-(\d+)$/.exec(String(it.id ?? ''))
        if (!m) continue // 注入合成项无对应真实轮
        const tid = turnIds[Number(m[1])]
        if (tid === undefined || seen.has(tid)) continue
        seen.add(tid)
        records.push({ id: tid, content: it.content ?? contents.get(tid) ?? '' })
        if (records.length >= topK) break
      }
      return { records, scores: records.map(() => 1) }
    },

    // —— 审计组原语：评测不需要，声明不支持 ——
    async enumerate() { throw new UnsupportedError('enumerate') },
    async provenance() { throw new UnsupportedError('provenance') },
    async subjectLookup() { throw new UnsupportedError('subject_lookup') },
    async delete() { throw new UnsupportedError('delete') },
    async export() { throw new UnsupportedError('export') },
    async mutationHistory() { throw new UnsupportedError('mutation_history') },

    async telemetry() { return [] },
  }
}

// 工厂导出 —— 每题一个全新 bucket，与官方 isolate=true 语义对齐
export default makeAdapter
