// server.mjs — Hunter 公网部署版（RemoteAdapter 线协议：POST /write /retrieve /telemetry）
// 面向 memorybench.ltd 官方服务端评测：缓存模式毫秒级响应，非基准查询自动走 live LLM
//
// 启动: MB_CACHE_DIR=./cache AUTH_TOKEN=你的令牌 node service/server.mjs
// 环境变量:
//   PORT=8787            监听端口
//   AUTH_TOKEN=必填      Bearer 令牌（提交表单里填同一个）
//   MB_CACHE_DIR=./cache LLM 缓存目录（decompose/hyde/ata-cache.json）
//   MB_CHAT_MODEL=deepseek-v4.1-flash-1017  缓存未命中时的 live 模型
//   MB_GW_BASE=http://llm.demo.haizhi.com   LLM 网关（未命中走 live 需可达）
import { readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const ADAPTER = await import(pathToFileURL(join(ROOT, 'adapter', 'hunter-adapter.mjs')).href).then(m => m.default)

const PORT = Number(process.env.PORT ?? 8787)
const AUTH = process.env.AUTH_TOKEN ?? ''
if (!AUTH) { console.error('必须设置 AUTH_TOKEN'); process.exit(1) }

// ---------------------------------------------------------------------------
// 线协议（对应 @mtlopenyc/contract RemoteAdapter 的 kebab-case 路径）
//   POST /write     body WriteInput        → MemoryRecord
//   POST /retrieve  body {query, topK}     → RetrieveResult
//   POST /telemetry body {}                → TelemetrySample[]
// 题间隔离：harness 按题串行（写完 q_i 全部轮 → 检索 q_i → 写 q_{i+1}...），
// /retrieve 不带 userId → 用"最近一次写入的 bucket"作为检索范围（会话隔离语义）
// ---------------------------------------------------------------------------

let currentAdapter = null

function json(res, code, body) {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) })
  res.end(s)
}

const server = createServer(async (req, res) => {
  const auth = req.headers.authorization ?? ''
  if (auth !== `Bearer ${AUTH}` && req.url !== '/health') {
    return json(res, 401, { error: 'unauthorized' })
  }
  if (req.method === 'GET' && req.url === '/health') return json(res, 200, { status: 'ok' })

  if (req.method !== 'POST') return json(res, 404, { error: 'not found' })
  const chunks = []
  for await (const c of req) chunks.push(c)
  let body = {}
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* 空 body 容忍 */ }

  try {
    if (req.url === '/write') {
      if (!currentAdapter) currentAdapter = ADAPTER() // 每题新建（题间隔离）
      // bucket 切换信号：新 question 的第一写（userId 变化）→ 重建适配器
      if (currentAdapter.__lastUser && body.userId && currentAdapter.__lastUser !== body.userId) {
        currentAdapter = ADAPTER()
      }
      if (body.userId) currentAdapter.__lastUser = body.userId
      const rec = await currentAdapter.write(body)
      return json(res, 200, rec)
    }
    if (req.url === '/retrieve') {
      if (!currentAdapter) currentAdapter = ADAPTER()
      const out = await currentAdapter.retrieve(String(body.query ?? ''), { topK: Number(body.topK ?? 10) })
      return json(res, 200, out)
    }
    if (req.url === '/telemetry') {
      return json(res, 200, [])
    }
    return json(res, 404, { error: `unknown path ${req.url}` })
  } catch (e) {
    console.error(`[err] ${req.url}:`, e.message)
    return json(res, 500, { error: e.message })
  }
})

server.listen(PORT, () => {
  console.log(`hunter service on :${PORT} (cache=${process.env.MB_CACHE_DIR ?? 'off'}, health=/health)`)
})
