# MemoryBench（memorybench.ltd）评测口径逆向文档

> 生成：2026-10-26 · 阶段 0 产出 · 全部结论基于对官方工具包源码的逐行阅读 + 本地实测验证

---

## 0. 一句话结论

**这个榜单的"私有评测"可以 100% 离线复现**：全部 500 题（含所谓私有 holdout 399 题）、切分算法（seed=42）、harness、评分公式都在公开 GitHub 仓库里；一个零依赖 TF-IDF 基线本地实测综合分 **0.7563**（公开集）/ **0.7677**（holdout），而当前榜首 AMe 只有 **0.004**——打榜 Top1 门槛极低，真正的工程量在于做一个高质量的检索适配器。

---

## 1. 榜单真实身份（重要背景）

| 项 | 真相 |
|---|---|
| 网站 | memorybench.ltd（宣传语"中立第三方"） |
| 实际运营方 | 个人开发者（GitHub `yihua-bot` / 自有品牌 myopenyc / Memory Trust Layer） |
| 真实工具包 | `github.com/yihua-bot/memory-bench`（MIT 许可，可自由使用修改） |
| 网站宣传的 `@mtl/sdk` | **npm 上不存在（404）**，是过时名字；实际包名 `@mtlopenyc/contract` / `@mtlopenyc/evaluation` / `@mtlopenyc/sdk` / `@mtlopenyc/connector` |
| 当前榜首 AMe | 运营方自己的产品（榜单里 AMe 的端点是 `memory.memorybench.ltd`，其部署归属同一家）——"既当裁判又当运动员"的风险真实存在 |
| 仓库引用的 `MTL-Research/AMe` GitHub 链接 | 404 不存在 |

**含义**：中立性依赖代码公开（这部分确实做到了，评分逻辑透明可审计），但不是机构级中立。打榜合规无风险（MIT 许可 + 接口开放）。

---

## 2. 数据集口径（已字节级验证）

### 2.1 来源与组成
- 源数据：HuggingFace `xiaowu0162/longmemeval-cleaned` → `longmemeval_oracle.json`，**500 题**，MIT 许可（论文 ICLR 2025, arXiv:2410.10813，UCLA+腾讯）
- 确定性分层切分（`scripts/split-longmemeval.ts`，mulberry32 seed=42 + Fisher-Yates + 按 question_id 稳定预排序）：
  - `longmemeval-public.json` = **101 题**（每题型抽 20%）——公开校准集
  - `longmemeval-holdout.json` = **399 题**（每题型 80%）——"私有"评测集
- **关键事实：holdout 文件就在公开仓库里**（`packages/evaluation/src/benchmarks/data/longmemeval-holdout.json`，11.7MB），代码注释声称"gitignore 防泄漏"但实际 `.gitignore` 没有排除它
- **本地重跑切分脚本 → git diff 字节级零差异**（已验证）：任何人可随时再生出完全相同的两份数据
- 榜单上 AMe 显示"500 题" = public 101 + holdout 399 合跑

### 2.2 题型分布（500 题）
| 题型 | 数量 |
|---|---|
| temporal-reasoning | 133 |
| multi-session | 133 |
| knowledge-update | 78 |
| single-session-user | 70 |
| single-session-assistant | 56 |
| single-session-preference | 30 |

### 2.3 每题数据结构
```jsonc
{
  "question_id": "gpt4_f420262c",
  "question_type": "temporal-reasoning",
  "question": "What is the order of airlines I flew with...?",
  "answer": "JetBlue, Delta, United, American Airlines",   // 答案（judge 用，检索评分不用）
  "haystack_session_ids": ["s1","s2",...],                 // 干草堆会话 id
  "haystack_sessions": [[{role, content, has_answer},...],...], // 会话×轮次
  "answer_session_ids": [...]                              // 答案所在会话
}
```

---

## 3. 评测流程口径（harness 逐行确认）

### 3.1 契约：9 原语，评测只用 3 个
- 审计组（评测不用）：`enumerate` / `provenance` / `subject_lookup` / `delete` / `export` / `mutation_history`
- **评测组（全部所需）：`write` / `retrieve` / `telemetry`**（telemetry 可选，不支持记 0 分成本）

### 3.2 单题执行流程
1. `isolate=true`（LongMemEval 默认）：**每题通过工厂函数创建全新 adapter**（题间隔离，每题只搜自己的 haystack）
2. 逐轮写入种子记忆：每个对话轮 = 一条 `write`，确定性 id 规则 **`{question_id}#s{会话序号}#t{轮次序号}`**，附带 metadata `{role, hasAnswer, sessionIdx, turnIdx, sessionId}`，userId=question_id
3. 检索：`retrieve(question, {topK: 10})`，只传 query 文本（**不传 userId**）；延迟 = 包住 retrieve 调用的 wall-clock
4. 标准答案（relevantIds）：
   - **轮次级**（479/500 题）：`has_answer=true` 的所有轮
   - **会话级回退**（21/500 题）：`answer_session_ids` 对应会话的全部轮

### 3.3 关键陷阱：工厂 vs 实例（实测数据）
CLI 允许 default-export 实例或工厂。export 实例 → 101 题记忆全部累积在同一实例里（隔离失效）：
| 模式 | recall@5 | ndcg@10 | 综合分 |
|---|---|---|---|
| 工厂（正确隔离） | 0.7753 | 0.7372 | **0.7563** |
| 实例（累积污染） | 0.6609 | 0.5960 | 0.6285 |

**结论：提交必须用工厂模式**（远程 HTTP 模式下等价于"每题开始前清空存储"——RemoteAdapter 评测时官方服务端每题重建适配器上下文，你的服务需要支持按 Bearer token/会话重置，或确认官方跑法）。

### 3.4 write 同步可见性
harness 写完种子后立刻 retrieve。**write 返回前记忆必须已可检索**（异步索引系统需自行 settle；官方方法学点名 Mem0 云端索引滞后约 10s，其适配器内置 `settleMs` 等待）。

---

## 4. 评分口径（纯函数，100% 确定）

### 4.1 指标公式（`metrics/retrieval.ts` 逐行确认）
- `Recall@k = |top-k ∩ relevant| / |relevant|`（relevant 为空记 1.0）
- `Precision@k = |top-k ∩ relevant| / k`（**分母恒为 k**，少返回=空位惩罚）
- `MRR = 1/rank(第一个相关项)`
- `nDCG@10`：二值相关性，`DCG=Σ rel/log2(rank+1)`，`IDCG=前 min(10,|relevant|) 位全相关`
- 报告 k∈{1,5,10}；所有指标在全部 query 上**算术平均**

### 4.2 综合得分（冻结公式）
```
score = (recall@5 + ndcg@10) / 2
```
- **不含延迟、不含 token 成本**（这两个只是展示列）
- **不含任何 LLM 主观分**。LLM Judge 存在但是 opt-in 附加维度（注入式 generate 函数，YES/NO 首行解析，0/1 打分），CLI 甚至没接它
- **对大模型零要求**：你的系统内部用什么 embedding/LLM 完全自由，榜单只看返回的 id 列表

### 4.3 置信区间
榜单 ±值 = bootstrap 95% CI（mulberry32 seed=42，2000 次重采样 per-query composite 的 2.5/97.5 分位）——确定性可复现。

### 4.4 id 保真 = 生命线
recall 按 **id 精确匹配**。适配器必须把写入时的文档 id 原样带回：
- 文档存储型：天然保 id
- 事实抽取型（Mem0/Letta/Zep 类）：官方方法学明确允许"来源记账"——write 时把基准 id 存进 `metadata.doc_id`，retrieve 时映射回来；这是官方认可的合法做法，不算作弊

### 4.5 反作弊机制
- Canary 陷阱题（对污染检测：干净系统在陷阱题上 recall 应≈0，背过答案的系统会异常高）
- queryResults 逐题公开可复算；`mtl validate` 格式校验；复现验证（提交后官方用同基准重跑对分）

---

## 5. 提交口径（两条通道）

### 通道 A：网站表单（Remote API，服务端跑）
- 你的服务暴露 HTTP 端点（RemoteAdapter 线协议）：`POST {endpoint}/{primitive}`，kebab-case 路径：`/write` `/retrieve` `/telemetry`（评测最少 2 个；其余 6 个审计路径可返回 501 或 `{"error":"unsupported"}`）
- 请求头 `Authorization: Bearer {token}`，JSON body；超时 30s/次
- 网站提交页只描述了 `/write` `/retrieve` 两个接口的最小契约：
  - `POST /write` body `{content, userId, id}` → 200 `{id, ...}`
  - `POST /retrieve` body `{query, topK}` → 200 `{records:[{id, content,...}], scores?}`
- 501/`{error:"unsupported"}` → 该原语记零分但不崩（榜单垫底也不除名）

### 通道 B：自跑 result.json 上传 / PR 到 `results/`
- `mtl run --out result.json` 自产 RunResult：`{benchmarkId, adapterId, timestamp, metrics{recallAt5,ndcgAt10,mrr,...}, queryResults[]}`
- `mtl validate result.json` 自检 → 上传网站表单或 GitHub PR
- 先以 ⏳待验证 展示 → 官方复现（同基准+你的适配器/key 重跑对分）→ ✓已验证

### 代码公开要求
**无强制开源**。远程模式代码不出域；自跑模式只交 JSON。开源/给 key 只是"已验证"徽章的加分项。

---

## 6. 本地实测记录（E:\memorybench\memory-bench，已全部跑通）

| 运行 | 集合 | recall@5 | ndcg@10 | 综合分 | P95 |
|---|---|---|---|---|---|
| TF-IDF（工厂，隔离） | public 101 | 0.7753 | 0.7372 | **0.7563** | 3ms |
| TF-IDF（工厂，隔离） | holdout 399 | 0.7913 | 0.7441 | **0.7677** | 2ms |
| TF-IDF（实例，累积） | public 101 | 0.6609 | 0.5960 | 0.6285 | — |
| **当前榜首 AMe（官方）** | 500 | — | — | **0.004** | 200ms |

复现命令（本机环境已就绪）：
```bash
cd /e/memorybench/memory-bench
npx tsx packages/sdk/dist/cli.js run \
  --adapter ./tfidf-factory.ts \
  --benchmark longmemeval-holdout \
  --out result.json
```

环境备注：仓库 `packages/connector/package.json` 残留旧包名 `@mtl/*`（npm 404），已本地改为 `@mtlopenyc/*`；构建脚本用了 Unix 命令，Windows 下需手动 `tsc -b` + `cp`（已完成）。

---

## 7. 对打榜的直接含义

1. **离线分数 = 官方分数**（同数据、同 harness、同确定性评分；唯一差异是官方跑分环境网络延迟，不影响综合分）
2. **榜首 0.004 = 形同虚设**：零依赖 TF-IDF 都是它的 190 倍。登顶只需交一个正常的混合检索适配器
3. **优化目标明确**：在隔离模式（每题独立 haystack，平均几百轮对话）下最大化 recall@5 + ndcg@10；题目语言为英文，语料是对话轮
4. **必须遵守的工程约束**：
   - 原文按 id 入库、id 原样返回（或官方认可的 doc_id 记账）
   - 工厂/重置语义（题间清空）
   - write 同步可检索
   - 恒定返回 top-10（少返回直接损 recall@10/ndcg）
5. **风险**：运营方是个人开发者，AMe 是自家产品；若后续官方"优化"跑分口径需关注方法学版本（`@mtlopenyc/evaluation` 版本号即方法学版本）。提交自跑 JSON 时保留 queryResults 全量数据以备复算。

---

## 8. atlas-memory-system 实测与调参（2026-10-26，服务器 10.10.0.41）

部署环境：`~/memorybench/`（atlas-deploy 镜像 aml-memory:mb + memory-bench 工具包 + atlas-adapter.mjs 桥接适配器），容器 32 核 CPU。

### 桥接适配器要点（atlas-adapter.mjs）
- 工厂导出 → 每题独立 bucket(user_id) = 完美隔离
- 按 session 缓冲逐轮 write → 每 session 一次 /add；`mem-{seq}` → turnIds[seq] 零偏移映射
- upd-{seq} 映射回真实轮；conflict-0/timeline-0/persona-0 注入项过滤
- top_k = 10+3 margin，过滤后取前 10
- 时间戳传 null（fmt_date(None)="unknown date" 全库同词，无假匹配）

### public 101 题消融矩阵
| 配置 | 综合分 |
|---|---|
| 原版 AML 参赛配置（全开） | 0.6348 |
| NEIGHBOR_SPAN=0（关邻居扩展） | 0.7388 |
| + 词法权重上调（dense 0.5/lex 1.0） | 0.7467 |
| + 去索引前缀（AML_INDEX_PREFIX=0） | **0.7481** |
| dense=0（纯 BM25） | 0.7237 |
| BM25 b=0.3 / b=0.0 | 0.6969 / 0.6850（暴跌，勿动） |
| 参考：TF-IDF 零依赖基线 | 0.7563 |

### 关键教训
- **邻居扩展是为"答案充分性"评测设计的**（AML 平台 Answer LLM 读上下文），在按 id 算 recall@5 的榜单上把高排名轮挤出 top-5（排名位移 ~3 倍）——这是 0.63→0.74 的主因
- dense（bge-small）在词法主导权重下有小幅正贡献（+0.015）
- BM25 长度归一化 b=0.75 必须保留（has_answer 轮普遍较长，去归一化反而惩罚长文档）
- 时间/实体/注入组件对此榜单的 id 召回几乎无影响（±0.001）

### 最终成绩（提交候选配置：NEIGHBOR_SPAN=0 + dense0.5/lex1.0 + 无索引前缀）
| 集合 | recall@5 | ndcg@10 | 综合分 | P95 |
|---|---|---|---|---|
| public 101 | 0.7645* | 0.7317* | **0.7481** | ~3s |
| holdout 399 | 0.7650 | 0.7355 | **0.7502** | 3.0s |
| **合并 500（官方口径）** | **0.7636** | **0.7360** | **0.7498** | — |

*对照：TF-IDF 基线 public 0.7563 / holdout 0.7677——此榜单 id 召回天然偏向纯词法，atlas 调优后与其在噪声区间内互有胜负；对榜首 0.004 均为碾压。

结果文件（服务器）：`~/memorybench/atlas-holdout-result.json`、`~/memorybench/ab-noprefix-lex1x.json`

