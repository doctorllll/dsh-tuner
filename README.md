# dsh-tuner

Usage-driven tuning advisor for DeepSeek Harness. It replays your **own** real requests,
measures each tuning area separately, and shows one recommendation per area — instead of
shipping one "best" preset that fits nobody.

侧栏「调优」页：基于本机真实调用回放，逐模块给建议。v0.2 起压缩卡可一键写入当前 agent preset，v0.3 起 DSH 升级后自动按新版默认重建，v0.4 起按模型给阈值、另有压缩健康卡。

## 安装

`desktop` profile 只认 App 自带 CLI（PATH 里的 npm `dsh` 会报 managed exclusively）：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add ~/code/dsh-tuner
```

或在 Harness 的 Plugins 页面安装本目录（`plugin_manager` / Add plugin → 本地路径）。
装完刷新页面，侧栏出现「调优 v0.4」。

## 模块

| 模块 | 数据 | 建议形态 | 一键应用 |
|---|---|---|---|
| 压缩策略 | 每条请求的 prompt 组成与所走的模型、每次压缩的前后大小、窗口与输出预留 | **按模型**的触发比例；附每个模型的回放表 | 写当前 agent preset 的 `compaction-basic.modelPolicies` |
| 压缩健康 | 实测压缩：次数、失败、单次耗时、耗时占比、摘要/压掉、同一轮反复压 | 正常 / 留意 / 空转，空转时指向上一张卡 | 无 |
| 缓存策略 | cacheRead 占比、请求间隔分布（p50/p90、>5min 占比） | 不装保温 / 可以试保温 / 保温没用、查前缀变化 | 无 |
| 工具面 | 工具声明的 token 规模、调用频次 | 仅观测 | 无 |
| 模型侧 | effort 分布、输出/输入比 | 仅观测 | 无 |

## 算法（v0.4）

compaction-basic 在估算上下文达到 `T = min(W × 比例, W − R − headroom)` 时压缩（W 窗口、R 输出预留），
压完逐字保留 `retain = (W − R) × retainRatio`。它压不掉的部分（系统提示、工具、当前这一轮自己的工具输出）
叠在 retain 上，所以压完落在 `post = retain + D`。

- **按模型**：会话中途会换模型，每条请求按它实际走的 provider/model 归类，窗口取会话里该模型的
  `request/context`，R 取请求头的 `maxTokens`。
- **D（保底）**：实测每次成功压缩后第一条请求的大小减去 retain，取中位数（失败的压缩没压动，不算）；
  不到 2 个样本时用开场请求 + 8k 摘要估。
- **回放**：每个模型的请求序列按"增长 = 实测 delta"重放，压缩后回到 post；压缩后第一条请求整段算未命中，
  之后只有新增部分未命中（命中按未命中的 0.1 计，只用来比较档位）。
- **选档**：30%–80% 各档里，排除"post 超过 T 的 70%"（下一步又会压，即跑步机）和"压缩耗时超过工作时间 5%"的档；
  剩下的取最省的，省得不到 3% 时取更高、更少压缩的那档。
- **不单独设**：样本不足、窗口未知、峰值从没到过 30% 阈值、或每档都不安全的模型——它们用顶层，
  而顶层写回官方默认（80% / 64k / 16%），新换的小窗口模型不会被一个比例压到空转。
- 写入的每条策略：`thresholdRatio` + `retainRatio 0.12` + `headroomTokens 8192` + `maxTokens 65536`。

实测（2026-11-06，本机 14 天 19 会话）：DeepSeek 1M 维持 30%（保底 137k，占 T 的 46%）；
grok@500k 在 30% 时保底 152k ≥ T 150k，回放与实测都是每步重压（实测 44 次压缩、17 次失败、耗时 21%），建议 50%。

## 一键应用（v0.2 起）

- 写入对象：**当前默认 agent preset** 的 `compaction-basic` 行：顶层回到官方默认，
  每个要单独设的模型一条 `modelPolicies`（v0.2/v0.3 是一个比例写在顶层，套所有模型）。
- 走宿主 `configEditor.edit()`：写 profile 的 `cordis.patch.yml`、校验完整候选配置、
  热重载并保留 `!!js` 表达式与注释；失败会自动还原文件。
- 插件再回读一次配置，值对不上就回滚，并在卡片里报「已回滚」。
- **只对新会话生效**；已开会话保留启动时的 preset revision，要 `/compact` 或重开。
- 可「恢复 preset 默认」：整份 preset 回到当前 DSH 的默认（覆盖行被删掉）。

## 升级自适应（v0.3）

profile 补丁对 preset 是「按 id 整段替换 config」，没有局部合并（读 DSH 0.2.2-rc.1
loader 源码确认），所以覆盖里必须带整份插件清单。v0.2 把清单抄的是写入当时的版本，
DSH 0.2.2-rc.1 删掉 `dsh-tool-subagent-control/list-agents` 后，抄下来的 PTC preset
点名不存在的模块，默认模式下新建 / 恢复会话全部失败。

v0.3 两处改动：

- **每次写入都以 configEditor 给的 `inherited`（当前 DSH 的默认 preset）为底**，
  只带上我们的 `compaction-basic` config。
- **启动时自动重建**：插件起来 1.5 秒后扫一遍带覆盖的官方 preset，覆盖里除
  `compaction-basic` config 之外与默认不一致的，按「默认 + 我们的压缩参数」重写，
  卡片顶部用橙字写明移除 / 新增了哪些行，`/tuner` 文本报告同样有一行。
  只认含 `compaction-basic` 行、且有出厂默认可比的 preset；自建（insert）的 preset 不碰。

代价：官方 preset 的覆盖里，除压缩参数外的手工改动会在下次启动时被冲掉——本机约定
preset 覆盖只由本插件写。

`headroomTokens: 0` 必须同时给正的 `maxTokens`（compaction-basic 的默认
`maxTokens = headroomTokens`，0 会过不了校验），所以写入值是 `maxTokens: 65536`。

## 限制（写在卡片里，不藏）

- **生效范围**：压缩引擎挂在 agent preset 内，profile 层直接改不到；应用必须写 preset。
- 回放是模型，不是复现：摘要质量变化不在估算内；保底 D 取实测中位数，某次大轮次里压缩的保底可能更高。
- 缓存保温不是本插件能提供的运行时能力；它只回答"值不值得装"。
- 样本少（<3 请求/会话）的会话不入统计。
- 覆盖是整份 preset config（configEditor 的语义）；上游默认变了，靠 v0.3 的启动重建跟进，
  在 App 下次启动时才生效。

## 路线

- v0.1：只读观测 + 分模块建议
- v0.2：压缩模块「一键应用」+ 收益预估
- v0.3：preset 覆盖随 DSH 升级自动重建（只保留压缩参数）
- v0.4（当前）：按模型阈值（计入压缩后保底、排除会空转的档）+ 压缩健康卡；缓存卡区分"过期"与"前缀变化"；工具面 / 模型侧改为仅观测
- 之后：模型侧建议（effort 档、子代理降级）

## 开发

```sh
node scripts/analyze.mjs --days 14 --limit 60 --policy '<当前 compaction-basic config JSON>'   # 离线跑同一份报告（同一套代码）
```

## 调试

- `POST /api/dsh-tuner/report`：报告。
- `POST /api/dsh-tuner/preset`：当前 preset 的压缩现状（before）。
- `POST /api/dsh-tuner/apply`：`{"days": 14}`（按该窗口的报告写入）、`{"policies": [{provider, model, thresholdRatio}]}`
  或 `{"action":"revert"}`。宿主路由对 curl 是 401，要在页面里 fetch。
