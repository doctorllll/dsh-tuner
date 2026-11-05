# dsh-tuner

Usage-driven tuning advisor for DeepSeek Harness. It replays your **own** real requests,
measures each tuning area separately, and shows one recommendation per area — instead of
shipping one "best" preset that fits nobody.

侧栏「调优」页：基于本机真实调用回放，逐模块给建议。v0.2 起压缩卡可一键写入当前 agent preset。

## 安装

`desktop` profile 只认 App 自带 CLI（PATH 里的 npm `dsh` 会报 managed exclusively）：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add ~/code/dsh-tuner
```

或在 Harness 的 Plugins 页面安装本目录（`plugin_manager` / Add plugin → 本地路径）。
装完刷新页面，侧栏出现「调优 v0.2」。

## 模块

| 模块 | 数据 | 建议形态 | 一键应用 |
|---|---|---|---|
| 压缩策略 | 每条请求的 prompt 组成（uncached / cacheRead / cacheWrite）、压缩事件、窗口与输出预留 | 触发比例 + headroom + retain；附阈值回放表与收益预估 | 写当前 agent preset 的 `compaction-basic` |
| 缓存策略 | cacheRead 占比、请求间隔分布（p50/p90、>5min 占比） | 装不装保温、TTL 下限 | 无 |
| 工具面 | 工具声明的 token 规模、调用频次 | PTC 模式下默认「保持现状」 | 无 |
| 模型侧 | effort 分布、输出/输入比 | 样本不足时不改档 | 无 |

## 算法

压缩阈值用**反事实回放**：把真实会话的请求序列按"增长 = 实测 delta"重放，假设压缩后
上下文收缩为 `retain × T + 3k 摘要`，扫 20%–80% 各档，输出成本比、压缩次数、单请求峰值。
选档规则：峰值不超过 `max(1.15 × 实测 p90, 0.6W)` 且压缩次数可控的前提下，取成本最低的一档。

收益预估 = 现状（无压缩）的 prompt 总和 − 建议档位的回放总和；同时给出压缩次数变化。
不含压缩后的缓存重建成本，也不含摘要质量变化。

## 一键应用（v0.2）

- 写入对象：**当前默认 agent preset** 的 `compaction-basic` 行（`thresholdRatio` /
  `headroomTokens` / `retainRatio` / `maxTokens`）。
- 走宿主 `configEditor.edit()`：写 profile 的 `cordis.patch.yml`、校验完整候选配置、
  热重载并保留 `!!js` 表达式与注释；失败会自动还原文件。
- 插件再回读一次配置，值对不上就回滚，并在卡片里报「已回滚」。
- **只对新会话生效**；已开会话保留启动时的 preset revision，要 `/compact` 或重开。
- 可「恢复 preset 默认」：只把 `compaction-basic` 的 config 还原为出厂层，不动同一
  preset 的其他覆盖。

`headroomTokens: 0` 必须同时给正的 `maxTokens`（compaction-basic 的默认
`maxTokens = headroomTokens`，0 会过不了校验），所以写入值是 `maxTokens: 65536`。

## 限制（写在卡片里，不藏）

- **生效范围**：压缩引擎挂在 agent preset 内，profile 层直接改不到；应用必须写 preset。
- 回放是模型，不是复现：压缩后的摘要长度、模型质量变化都不在估算内。
- 缓存保温不是本插件能提供的运行时能力；它只回答"值不值得装"。
- 样本少（<3 请求/会话）的会话不入统计。
- 覆盖是整份 preset config：应用后该 preset 的 config 固定在 profile 层，上游 bundle
  以后改默认值不会自动跟进来（这是 configEditor 的已知取舍）。

## 路线

- v0.1：只读观测 + 分模块建议
- v0.2（当前）：压缩模块「一键应用」+ 收益预估
- v0.3：模型侧建议（effort 档、子代理降级）

## 开发

```sh
node scripts/analyze.mjs --days 14 --limit 60        # 离线跑同一套指标
```

## 调试

- `POST /api/dsh-tuner/report`：报告。
- `POST /api/dsh-tuner/preset`：当前 preset 的压缩现状（before）。
- `POST /api/dsh-tuner/apply`：`{thresholdRatio, headroomTokens, retainRatio}` 或
  `{"action":"revert"}`。宿主路由对 curl 是 401，要在页面里 fetch。
