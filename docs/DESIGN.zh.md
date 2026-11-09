# dsh-tuner 原理与实现

[README](../README.zh.md) · 中文

这份文档写给想知道"建议是怎么算出来的"、或者要改代码的人。日常使用看 README。

## 数据从哪来

宿主插件通过 DSH 的 `ctx.sessionQuery.listSessions()` / `readSession(id)` 读本 profile 的会话，用到的事件：

| 事件 | 用途 |
|---|---|
| `assistant/message.usage` | 每条请求的 input / cacheRead / cacheWrite / output |
| `request/context`、`request/header` | 窗口大小、输出预留（`maxTokens`）、实际走的 provider / model、推理档 |
| `compaction/start`、`compaction/end`、`compaction/summary` | 每次压缩的前后大小、失败原因、摘要模型、是否手动触发 |
| `llm/retry`、`llm/retry-started` | 重试原因、重试前等了多久 |
| `tool/result`、`tool/ptc-dispatch` | 工具调用、失败原因、输出大小（含 `run_code` 里调的工具） |
| `hook/result` | PostToolUse 钩子耗时 |

子代理会话（`delegationDepth > 0`）不计；fork 出来的会话计入，和父会话共享的历史只算一次。少于 3 条请求的会话不计。全部计算在本机完成，不调模型、不联网。

## 压缩策略：按模型回放

compaction-basic 在估算上下文达到 `T = min(W × 比例, W − R − headroom)` 时压缩（W 窗口、R 输出预留），压完逐字保留 `retain = (W − R) × retainRatio`。压不掉的部分（系统提示、工具声明、当前这一轮自己的工具输出）叠在 retain 上，所以压完落在 `post = retain + D`。

- **按模型**：会话中途会换模型，每条请求按它实际走的 provider / model 归类；窗口取会话里该模型的 `request/context`，R 取请求头的 `maxTokens`。
- **D（压缩后保底）**：实测每次成功压缩后第一条请求的大小减去 retain，取中位数；失败的压缩没压动，不算。不到 2 个样本时用该模型所在会话的开场请求（系统提示 + 工具 + 第一句话，不管是哪个模型发的）+ 8k 摘要估。0.5.2 前取的是该模型自己的第一条请求：中途换上来的模型，这条已经带着前面的整段对话（作者本机 GLM 在 179k 处接手，保底估成 326k），30%、40% 都被误判为"会反复压"，结论被推到 80%。
- **回放**：每个模型的请求序列按"增长 = 实测 delta"重放，压缩后回到 post；压缩后第一条请求整段算未命中，之后只有新增部分未命中（命中按未命中的 0.1 计，只用来比较档位，不是账单）。
- **选档**：30%–80% 各档里，排除"post 超过 T 的 70%"的档（下一步又会压，即"跑步机"）和"压缩耗时超过工作时间 5%"的档；剩下的取最省的，省得不到 3% 时取更高、更少压缩的那档。
- **不单独设**：样本不足、窗口未知、峰值从没到过 30% 阈值、或每档都不安全的模型，用顶层；顶层写回官方默认（80% / headroom 64k / retain 16%），以后新换的小窗口模型不会被一个比例压到空转。
- **写入的每条策略**：`thresholdRatio` + `retainRatio 0.12` + `headroomTokens 8192` + `maxTokens 65536`。`headroomTokens` 小于默认时必须同时给正的 `maxTokens`（compaction-basic 默认 `maxTokens = headroomTokens`），否则过不了校验。

一个例子（作者本机 14 天、19 个会话）：1M 窗口的 DeepSeek 维持 30%（保底 137k，占 T 的 46%）；500k 窗口的 Grok 在 30% 时保底 152k ≥ T 150k，回放与实测都是每步重压（实测 44 次压缩、17 次失败、耗时占 21%），建议 50%。这就是"一个比例套所有模型"会出的事。

## 压缩健康：按当时生效的阈值分档

健康卡看的是已经发生的压缩：次数、失败及原因、单次耗时、耗时占比、同一轮反复压。每次压缩按触发点归到**当时生效的阈值**：

- 只有"现在这一档"有问题才算问题：区间太小 → 提阈值；摘要为空 → `compactionRetries: 2`；摘要不比原文小 → 调 `maxTokens`；太费时 → 换更快的 `summarizationModel`。
- 旧阈值下的问题显示为"已修正 / 已换档"；刚换了设置、还没有数据时显示"待观察"。

## 模型侧与工具面

- **模型侧**：读 `llm/retry`，按原因分（长时间无输出、首包超时、断连、限流…），并算重试前白等的时间。长时间无输出超时集中在最高推理档时，建议降到 high。推理档在模型选择里改，本插件不写。
- **工具面**：每个工具的调用、失败原因、输出大小（p50 / p90），钩子耗时占比。`run_code` 超时多 → 给一句 AGENTS.md（预计超过 1 分钟的命令传 `timeoutMs`）；改文件前没读多 → 给一句"先 read 再 edit"；钩子占工作时间 ≥ 5% → 建议收窄 matcher。

## 一键应用怎么写

- 写入对象：**当前默认 agent preset** 的 `compaction-basic` 行。顶层回到官方默认，每个要单独设的模型一条 `modelPolicies`；你在策略里另加的键（如 `summarizationModel`）写入时保留。
- 走宿主的 `configEditor.edit()`：写 profile 的 `cordis.patch.yml`，校验完整候选配置，热重载，保留 `!!js` 表达式与注释；失败自动还原文件。插件再回读一次，值对不上就回滚，并在卡片里报"已回滚"。
- **只对新会话生效**：已开会话保留启动时的 preset revision，要 `/compact` 或重开。
- 「恢复 preset 默认」：把 `compaction-basic` 那一行恢复成当前 DSH 的默认；恢复后若整份 preset 与默认完全一致，覆盖整段删掉。

## preset 覆盖与 DSH 升级

DSH 的 profile 补丁对 preset 是"按 id 整段替换 config"，没有局部合并，所以覆盖里必须带整份插件清单（configEditor 的语义："A complete config override … pins their current raw values"）。

- **v0.2 的教训**：清单抄的是写入当时的版本。DSH 0.2.2-rc.1 删掉 `dsh-tool-subagent-control/list-agents` 后，抄下来的 PTC preset 点名不存在的模块，默认模式下新建 / 恢复会话全部失败。
- **v0.3**：写入以 `inherited`（当前 DSH 的默认 preset）为底，只带压缩参数；启动时把官方 preset 的覆盖都按"默认 + 压缩参数"重建。副作用：覆盖里别的手工改动会被冲掉。
- **v0.5.1（现在）**：
  - 只在覆盖点名了当前 DSH 已不提供的行时才重建；重建时两边都有的行用你的版本，只有默认里有的行补上，默认里已没有的行删掉；preset 顶层字段（提示词等）原样保留。卡片顶部写明删了 / 加了哪些行。
  - 一键应用 / 恢复默认都在你存的 preset 上原地改，只动 `compaction-basic`。
  - 代价：没有失效行时，上游对已有行默认值的调整不会自动跟进（DSH 整段覆盖本身的语义）。要跟进，在设置里把该 preset 恢复默认，再重新应用压缩建议。
  - 实测（临时 DSH_HOME）：覆盖里关掉 `time-context`、改 persona 前缀，启动、应用、恢复默认后都还在；再加一行默认里没有的 `stale-row`，启动后只删这一行。

## 宿主路由（调试用）

都挂在 DSH 的连接上，需要页面里已登录的会话（直接 curl 会 401；要先用 `/?token=…` 拿 cookie）。

- `POST /api/dsh-tuner/report` `{"days": 14, "maxSessions": 60}`：报告。
- `POST /api/dsh-tuner/preset`：当前 preset 的压缩现状与上次启动重建的结果。
- `POST /api/dsh-tuner/apply`：`{"days": 14}`（按该窗口的报告写入）、`{"policies": [{"provider", "model", "thresholdRatio"}]}`（指定值），或 `{"action": "revert"}`。

## 离线报告

```sh
node scripts/analyze.mjs --days 14 --limit 60 \
  --policy '<当前 compaction-basic config 的 JSON>' --root ~/.dsh/sessions
```

和面板同一套代码，直接读会话文件，只读。

## 代码结构

| 文件 | 内容 |
|---|---|
| `index.js` | 宿主插件：读会话、各模块分析与建议、preset 读写与启动重建、宿主路由、`/tuner` 命令 |
| `client.js` | 网页客户端：侧栏「调优」页（总览 + 详情），无构建步骤，配色全用客户端主题变量 `--dsw-alias-*` |
| `cordis.patch.yml` | bundle 挂载行 |
| `scripts/analyze.mjs` | 离线报告 |

坑：DSH 客户端的 React 组件 `style` 只能是对象，传 CSS 字符串会让整个页面不渲染；样式走 className + 一个 `<style>` 元素。
