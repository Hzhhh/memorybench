# MemoryBench Hunter

> 冲击 [memorybench.ltd](https://memorybench.ltd) 榜首的专用检索系统。
> 当前榜首 AMe 0.876 ± 0.05（2026-10-26），目标 **0.90+**。

## 架构

```
问题 ──► LLM 查询分解（网关 chat，1-4 个证据式子查询）
   │
   ├─► BM25 通道（每子查询 top-30）
   ├─► 稠密通道（text-embedding-v4，top-30）
   │        └─ RRF 融合（k=60）
   ▼
候选池 top-50 ──► 交叉重排（bge-reranker-v2-m3 / gte-rerank-v2）──► top-10
```

设计要点：
- **进程内适配器**：直接实现 `@mtlopenyc/contract` 的 MemoryAdapter（工厂模式，每题隔离），无服务跳数
- **全链路降级**：LLM 失败→单查询；embedding 失败→纯 BM25；rerank 失败→融合序
- **模型全部走海致网关**（`http://llm.demo.haizhi.com`，OpenAI 兼容）

## 环境

```bash
# 1. 克隆评测 harness（yihua-bot/memory-bench）并构建（详见 docs/benchmark-spec.md）
git clone https://github.com/yihua-bot/memory-bench.git
cd memory-bench && npm install && (各包 npx tsc -b)

# 2. 把本仓库放入 harness 目录（或软链）
cp -r hunter/ <harness>/hunter/

# 3. 跑分
node packages/sdk/dist/cli.js run \
  --adapter ./hunter/adapter/hunter-adapter.mjs \
  --benchmark longmemeval-public \
  --out result.json
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `MB_DECOMP` | 1 | LLM 查询分解 |
| `MB_DENSE` | 1 | 稠密通道 |
| `MB_RERANK` | 1 | 重排 |
| `MB_POOL` | 50 | 重排候选池 |
| `MB_CAND` | 30 | 每查询每通道 top-N |
| `MB_W_BM25` / `MB_W_DENSE` | 1/1 | RRF 权重 |
| `MB_EMB_MODEL` | text-embedding-v4 | 向量模型 |
| `MB_RERANK_MODEL` | bge-reranker-v2-m3 | 重排模型 |
| `MB_CHAT_MODEL` | deepseek-v4-flash-0731 | 分解用 LLM |

## 成绩记录

| 日期 | 配置 | public 101 | holdout 399 | 备注 |
|---|---|---|---|---|
| 2026-10-26 | atlas 原版 | 0.6348 | — | AML 参赛配置 |
| 2026-10-26 | atlas 调优（span0+lex1x+无前缀） | 0.7481 | 0.7502 | 合并 500 题 0.7498 |
| 2026-10-26 | hunter v3（+t0先验+子查询稠密） | 0.8159 | — | |
| 2026-10-26 | hunter v5a（分类路由+轮转+定向选证） | **0.8340** | 跑分中 | 当前最佳，holdout 验证中 | |

## 关键情报（详见 docs/benchmark-spec.md）

- 理论天花板：**0.9835**（recall@5 上限 0.967 / ndcg@10 上限 1.0）
- 差距集中在 **multi-session（当前 0.616/133 题）** 和 **temporal-reasoning（0.716/133 题）**
- 91.6% 的题 relevant 数 ≤3；整题全错的仅 16/500——丢分主要是排序问题，rerank 是第一杠杆
