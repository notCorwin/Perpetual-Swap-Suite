# Perpetual Swap Suite 改进计划

评估日期：2026-10-17。代码基线：`470916a`。依据：[AGENTS.md](../AGENTS.md) 及本次提出的工程原则。

优先统一市场数据与指标的数学口径，再完成可配置筛选、独立排名、后台数据管理和双栏工作区。现有实现可以替换；不以保留旧接口、旧字段或现有测试断言为验收目标。本文件保留原始评估；后续已按本计划实施，参见 [实施与验收记录](IMPLEMENTATION.md)。下列代码依据固定到原评估基线。

## 当前结论

项目已有可用的 Electron、Parquet、DuckDB、图表计算 Worker 和真实 Electron 测试基础。主要问题不是缺少组件，而是同一业务概念存在多条不一致的实现路径：列表与图表分别初始化指标，候选发现和最终筛选分别写死条件，窗口存在多套缩放规则，测试又固定了部分偏离规范的行为。

已通过真实临时存储复现指标不一致：同一合约、周期和时间戳，列表 EMA 为 `100.04828624309636`，图表 EMA 为 `220.62911793477585`；RSI24 分别为 `24.891861270985572` 和 `22.7014139117355`。根因是列表只用最近 201 根 K 线重新初始化，图表使用全部已保存历史。这个问题可能改变信号方向，必须先于视觉调整处理。

优先级定义：**P0** 为影响数值、公式或信号可信度的问题；**P1** 为核心需求、数据可靠性及交付流程缺口；**P2** 为视觉、可维护性和体积等收敛工作。P2 不代表可以跳过 AGENTS 的要求。

## 规范对照

| 规范 | 当前状态及代码依据 | 改进目标 |
| --- | --- | --- |
| Electron 桌面容器 | 已实现，renderer 隔离；[main](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/electron/main.js)、[preload](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/electron/preload.cjs) | 保留隔离，统一一个受校验的桌面 API |
| 最小 5m，支持 5m/15m/1h | 已实现；[timeframe](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/src/timeframe.ts#L1) | 保留原生周期，默认图表改为 15m |
| shadcn 默认风格，Base UI + CSS | 当前为 `radix-nova` 和 Radix，并有自定义玻璃材质；[配置](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/components.json#L3)、[Button](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/src/components/ui/button.tsx#L4) | 整体切换 Base UI 基础组件，收敛默认风格 |
| Parquet 历史，DuckDB 查询，SQLite 频繁更新 | 前两项实际使用；配置为 JSON，catalog 为 Parquet 快照；[Store](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/electron/services/market-store.js#L33)、[配置写入](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/electron/main.js#L57) | SQLite 承担设置、当前资格和同步任务等可变元数据 |
| 六项筛选独立启停、调参、持久化 | 只有 Volume Stability 开关；阈值及提前过滤写死；[阈值](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/electron/services/market-service.js#L6)、[候选发现](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/electron/services/market-service.js#L1276) | 一个筛选配置贯穿发现、计算、资格判定和缓存 |
| USDT 永续且无休市机制 | 已筛选 live、USDT SWAP 和 `instCategory === '1'`；[属性筛选](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/electron/services/market-service.js#L1276) | 用官方属性契约证明无休市，不能仅依据当前字段名推断 |
| 全局等宽数字、指定涨跌色 | 已实现；[全局规则](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/src/index.css#L342)、[明暗颜色](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/src/index.css#L198) | 保留；补充灰度辨识和实际背景对比度验收 |
| 左列表、右图表 | 选中后整页切换为图表；[页面分支](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/src/App.tsx#L288) | 同一工作区持续显示两栏 |
| 按独立时间窗口的变化率绝对值降序，默认 15m | 前端默认 Opportunity，服务端另有 24h 排序；[默认状态](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/src/App.tsx#L167)、[排序键](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/src/market-sort.ts#L7) | 独立 `rankingLookback`，与图表周期分别持久化 |
| EMA200、BOLL20/2、VWAP14 | EMA/VWAP 已显示，BOLL 被 Log BB 替代；[公式](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/electron/services/indicators.js#L40) | 恢复指定 BOLL，并固定 VWAP 的量纲与公式 |
| ROC/MAROC、三 RSI、OI、Taker 面板 | 已实现；[图例与面板](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/src/MarketChart.tsx#L328) | 保留，验证单位、初始化和跨入口一致性 |
| 完成 K 线读持久化，未完成 K 线不落盘 | 业务链路已区分；[写入入口](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/electron/services/market-service.js#L921)、[图表加载](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/electron/services/prepared-chart-service.js#L375) | 将确认状态校验下沉到唯一写入边界，防止旁路 |
| 增量补缺、不阻塞交互 | 已有缺口检测、请求合并、优先队列和计算 Worker；[缺口](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/electron/services/market-store.js#L249) | 统一同步调度，并持久化任务，覆盖范围不再依赖打开哪个图表 |
| 设置中手动完整性校验 | 没有对应入口；[当前设置](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/src/App.tsx#L309) | 提供可取消、可恢复、可复验的后台审计与修复 |
| 英语界面 | 常规控件为英语，但 AI 内置问题和回答指令为中文；[分析提示](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/src/chart-analysis.ts#L5) | 所有内置文案、默认问题、生成语言指令和语言声明使用英语 |
| 固定基准统一缩放 | 列表只缩小，普通图表比例恒为 1；[列表](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/src/MarketListViewport.tsx#L28)、[图表](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/src/ChartWorkspaceViewport.tsx#L9) | 一个工作区基准、一套比例及坐标转换 |
| Signed Relative Change | 核心公式已用绝对值分母；零基线文案与服务行为不一致；[格式说明](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/src/market-percent.ts#L4)、[计算](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/electron/services/market-service.js#L136) | 统一公式、零基线、缺失值和百分比展示 |
| GitHub Actions、构建安装并启动 App | 已有 main 发布流程，但没有 PR 门禁、lint 和安装产物 smoke；[workflow](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/.github/workflows/release.yml#L3)、[打包](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/scripts/package-electron.sh#L4) | 检查前移；本地交付验证 `/Applications` 中的新产物 |

## 目标架构

采用清晰的业务边界，不引入通用插件框架、兼容宿主层或多套回退计算。

- **OKX adapter**：解释官方字段、单位、确认状态与时间戳；负责 REST 历史与推送事件的规范化。无效记录在此拒绝并报告，不把缺失值转成假零。
- **市场数据服务**：拥有一套补缺调度、实时形成中 K 线状态和 canonical indicator series。列表、图表及评分只读取这套结果的投影。
- **存储**：Parquet 是已完成市场历史的事实来源，DuckDB 查询；SQLite 保存筛选设置、当前合约资格、同步任务、审计进度和必要检查点。不要让同一类已完成 K 线在 SQLite、Parquet 各自成为事实来源。
- **后台执行**：复用现有 Worker 能力，把批量计算、同步和审计放在后台执行边界。先用验收确认主进程与 renderer 交互延迟；确需迁移的职责整体迁移，不为每个函数增加一层代理。
- **Electron main/preload**：管理窗口、外链、凭据及明确的桌面命令。只暴露一个共享类型、运行时校验的 API。
- **React 工作区**：左侧筛选合约与排名，右侧价格和指标；显示数据与资格状态，不重新计算业务指标。

Parquet 的现有原子发布、DuckDB 串行查询、缺口分段初始化、revision/generation 失效保护和旧响应防覆盖应保留其行为。是否保留对应代码由新边界决定。

## 分阶段工作包

### 阶段一 统一数学口径和指标来源

**优先级 P0。依赖：无。**

1. 固定公式、输入量纲、初始化起点、最早有效样本、缺口重启及修订规则，形成指标契约。递归指标的种子由同一 canonical 连续历史决定，不能由可见窗口或缓存长度决定。
2. 删除列表的 201 根独立重算路径（[readListBars](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/electron/services/market-service.js#L494)）；列表、图表和机会评分共享同一指标结果。历史扩展或修订后，从受影响的初始化边界重新生成并同时发布。
3. 将 Log BB 默认链路替换为 BOLL(20,2)：`middle = SMA(close,20)`，`upper/lower = middle ± 2 × populationStdDev(close,20)`。一并替换字段、图例和依赖该语义的评分；不保留旧字段别名或双算回退。
4. VWAP 当前以 `quoteVolume` 再乘典型价格，形成另一种价格加权。[parser](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/electron/services/market-service.js#L244) 也丢弃了基础币成交量。建议明确采用 14 根滚动 `sum(HLC3 × baseVolume) / sum(baseVolume)`，持久化所需基础量；如产品选择实际成交均价，则改用 `sum(quoteVolume) / sum(baseVolume)` 并明确命名。公式选择在本阶段编码前定稿，不能沿用 README 的现状描述作为授权。
5. Signed Relative Change 统一为 `(current - previous) / abs(previous) × 100%`；建议零基线返回 unavailable，展示 `—`，避免一处返回 null、另一处宣称无穷大。区分这种变化率与 Taker imbalance 等独立比例。
6. EMA 使用 SMA200 初始化、乘数 `2/201`；ROC9、MAROC9 和 Wilder RSI 的首个有效位置必须明示。RSI 的全平、单边上涨、单边下跌等边界分别给出约定；禁止通过“未报错/非空”证明数学正确。
7. 公式与输入 schema 更新后，明确提升 calculation version，作废旧派生快照。原始且单位明确的数据继续使用；无法证明单位正确的数据标记待重取，不做静默猜测。

**验收：**

- 同合约、周期、时间戳、数据修订版本的 EMA、RSI 和方向信号，在列表与图表一致；覆盖补历史、改历史、重启、LRU 淘汰和实时叠加。
- 独立黄金样本：close 为 1…20 时，BOLL 中轨 `10.5`，上轨约 `22.0325625947`，下轨约 `-1.0325625947`；不能接受当前 Log BB 中轨约 `8.30436`。若保留对数价格轴，明确处理非正下轨，不篡改计算结果或静默漏画。
- 若采用上述 HLC3 VWAP，14 根等基础量、前后各 7 根价格 100/200 时结果为 `150`，不是当前的 `166.6667`。
- 独立期望值验证 EMA、BOLL、VWAP、ROC、MAROC、RSI；涵盖常量、单调、交替、零量、零基线、缺口和最短初始化窗口。比较浮点时使用明确且量级相关的误差容限。

### 阶段二 建立可靠的配置和数据同步

**优先级 P1。配置与任务模型可和阶段一并行；指标派生发布依赖阶段一。**

1. 用事务式 SQLite 设置仓库整体替换 [JSON read-merge-write](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/electron/main.js#L57)。配置带 schema 与修订号，renderer 只管理表单草稿和提交结果；删除由前端分字段重试承担一致性的设计。
2. 明确每个合约、周期、数据源的目标覆盖起止范围。AGENTS 未规定历史起点或保留年限，这需要本阶段产品决策；指标热身范围与用户历史范围分别记录，不能用当前 96 根窗口充当历史完整性定义。
3. 合并列表 warmup 与图表 repair 的重复任务状态，建立一套增量同步协调器。SQLite 保存任务、游标、重试时间和完成状态；重启可以继续，前台请求可以提升同一任务的优先级。
4. 校验 ingestion contract：时间戳落在周期网格，OHLC 为正且高低关系成立，量非负、单位明确，只有 confirmed 数据可进入历史写入边界。读写失败、数据不存在、来源明确不提供必须分别表达。
5. 完整性审计检查时间缺口、重复逻辑键、坏 OHLC/量、错误单位或周期、未确认记录和损坏文件；结果包含合约、周期、范围、来源与可修复性。设置中提供开始、进度、取消、修复与复验。
6. Parquet 使用显式 schema，替换 JSON 自动推断及运行时字符串补救。当前 [每批写入都会重并当天分区](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/electron/services/market-store.js#L109)，先合并同分区的批量更新并测量写放大及延迟，只有超出预算才增加有界压实。保留现有简单分区、原子发布和写后失效机制。

**验收：**

- 并发保存筛选、周期和外观等不同字段，全部保留，重启一致；事务失败不产生部分更新。
- 不打开图表，也会完成约定范围的后台下载；中途退出后续跑，只拉缺失区间。
- 列表和图表并发请求相同历史范围，共享源任务；已完整历史不重复请求，临近收盘修订属于显式刷新策略。
- 注入缺口、坏数据和损坏文件后，审计准确定位；只修复异常范围，再审计通过。
- 审计和回填期间，搜索、选择合约、切周期和取消任务可用。使用统一设备和夹具报告交互延迟分位数，先记录基线，再设预算；不能仅以使用 async/Worker 判定通过。

### 阶段三 重写筛选和独立排名

**优先级 P1。依赖：阶段一的统一数据口径、阶段二的事务设置。**

1. 六项条件分别定义 `enabled`、阈值及必要参数；Slippage 的交易名义金额独立配置，默认 100,000 USDT。配置必须贯穿候选发现、网络取数、最终判定、UI 和缓存身份。
2. 删除候选发现中的硬编码 spread/turnover 排除（[位置](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/electron/services/market-service.js#L1276)）。禁用条件后，任何前置优化都不能继续排除对应合约；启用条件全部满足才进入合格列表。
3. 修正严格边界：depth 要求单侧均 **大于** 100,000，而当前累计封顶 100,000 再按 `>=` 判断。单独计算可观察深度和固定名义金额滑点；有限档位不足以证明通过时返回 Unknown。
4. 24h USDT 成交额不得以 `volCcy24h × latestPrice` 冒充实际成交额。核验 OKX 官方字段，采用真实 quote amount；若由本地 K 线汇总，必须覆盖完整滚动 24h，明确边界和未完成段的处理。
5. Volume Stability 必须检查最近 24 个连续、已完成 1h 区间；保留零量并区分零量失败与缺样 Unknown。当前零量被过滤后会因样本不足返回 null，不属于误判通过；真正缺口是没有验证连续性及样本所属时间范围。
6. 用官方合约元数据明确 USDT 本位、永续与无休市规则。[官方 Instruments 定义](https://www.okx.com/docs-v5/en/#public-data-rest-api-get-instruments) 中，`instCategory=1` 表示基础资产属于 Crypto；资产类别不能单独充当交易时段契约，仍需交易规则和反例验证，尚不能断言当前映射必然错误。
7. 每项资格有观测时间与新鲜度，整体结果为 Verified / Failed / Unknown。删除无期限恢复旧 catalog 的回退。刷新失败不得延长旧观测有效期；当前配置下仍完整且未过期的观测可用至有效期结束，否则变为 Unknown。严格筛选区仅包含未过期的 Verified；离线历史仍可用于图表，不冒充当前流动性合格。
8. 将 `rankingLookback` 与 `chartTimeframe` 分开，均默认 15m，分别持久化。建议排名使用同一 as-of 的已完成 5m close 与回看基准，按变化率绝对值降序；若要 live numerator，需要额外固定事件时间规则。删除服务端 24h 与前端 Opportunity 互相覆盖的默认排序。

**验收：**

- 六项条件逐项调整、关闭、重启；关闭 spread 或 turnover 后，符合其余条件的合约确实进入列表。
- 阈值相等、刚高于、刚低于均有测试；双侧成交均价、合约乘数、缺档和零量有独立算例。
- 排名样本 `+2%、−5%、+1%` 排为 `−5%、+2%、+1%`；空值最后，平局按固定 instrument ID 顺序。改图表周期不改变排名时间窗口。
- 改参数、资格过期、单项数据缺失且无有效旧观测时，不显示为 Verified；刷新失败不延长有效期，旧配置缓存不能参与新配置判定。

### 阶段四 完成实时数据生命周期

**优先级 P1。依赖：阶段二的统一同步协调器。**

当前最新 K 线由每分钟 REST 刷新（[刷新间隔](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/electron/services/market-service.js#L23)），与实时更新目标有差距。用 OKX 推送更新内存中的 forming candle，REST 负责初始化、断线补缺及已确认数据修正；这些职责不互相充当无限回退。

**验收：** 重复、乱序、断线重连和收盘确认都能正确处理；未完成 K 线始终不落盘；确认写入成功后，列表与图表统一读取持久化事实。显式显示连接状态和数据时间；在约定测试环境记录事件接收到绘制的延迟，并按阶段二形成的预算验收。

### 阶段五 一次完成双栏工作区与组件收敛

**优先级 P1 的布局和语言，P2 的基础组件与视觉；作为同一 UI 改造交付，避免重做两遍。依赖：新的设置、排名和图表数据契约。**

1. 重写 App 组合为始终存在的左合约列表、右图表工作区。删除选中后提前返回详情页的分支；筛选变化后若选中合约不再合格，明确选择下一合格项或显示无合格合约状态。
2. 基于当前稳定的 shadcn Base UI 组件替换 Radix primitives；同步重建 Button、Dialog、Popover、Select、Toggle 等基础层，删除 Radix 专用 API 和兼容包装。
3. 以 shadcn 默认视觉为基准，保留金融涨跌、图表和布局所需语义 tokens。精简玻璃材质、透明度和独立 surface 风格，删除相应无作用设置与专门锁定旧材质的测试。
4. 一个固定设计基准宽度、一套全局缩放；列表、图表、分析区域、portal 和截图/指针坐标使用同一规则。基准宽度由双栏原型验证后固定为 token，不沿用多个页面各自的局部基准。
5. 图表默认 15m，主图显示 EMA200、BOLL20/2、VWAP14，下方保留 ROC/MAROC、三 RSI、OI Contracts、Taker Contracts。
6. 涨跌色保持 AGENTS 指定 RGB。数值保留正负号；蜡烛增加空心/实心或等价非颜色编码，EMA/VWAP 使用可辨线型与图例。浅色背景下可让主数值用高对比前景色、规定色用于方向标记，兼顾指定色与可读性。
7. 将 AI 的内置问题、生成语言指令和 `lang` 改成英语。继续作为可选能力，使用无网络 runner fixture 验收，不让配置 AI 阻断核心市场工作区。

**验收：**

- 两栏在搜索、选择、周期切换、加载和错误状态持续存在，键盘选择与焦点行为正确。
- 在 `0.75B / B / 1.25B` 宽度、DPR 1/2 下，统一 `scale = viewportWidth / B`；portal、指针和截图边界的对齐误差目标不超过 1 CSS px。
- Light/Dark 与灰度场景可识别蜡烛方向、EMA/VWAP，保留已有 RSI 虚线和 Taker hatch；真实合成背景下，普通文本对比度目标至少 4.5:1，关键图形至少 3:1。
- 产品内置文本全英语，数字为 tabular figures；生产组件不再导入 Radix。Token 检查配合实际渲染验收，不代替视觉检查。

### 阶段六 收敛 Electron 边界与交付流程

**优先级 P1/P2。可从阶段一同步启动；最终安装验收依赖全部产品改造。**

1. 共享 command schema、请求和响应类型；验证允许窗口的 main frame 及 payload。禁止应用窗口导航到外部内容，外链限制允许协议。
2. 统一 `window.radarDesktop` 或等价单一 API，删除 [webkit 兼容入口](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/electron/preload.cjs#L10)、无效 ROC/MAROC 请求参数和返回成功却不执行的窗口操作。同步删除强制要求旧入口存在的源码正则测试。
3. 补全 main、preload、services 与关键 scripts 的静态检查；清理 [失效的 ci-local.ts 引用](https://github.com/notCorwin/Perpetual-Swap-Suite/blob/470916a/tsconfig.node.json)。是否统一 TypeScript 由共享契约与维护收益决定，不为更换后缀重写代码。
4. GitHub Actions 增加 PR 验证：lint、类型检查、核心业务测试及必要 Electron E2E；main 发布依赖确定性验证和打包产物 smoke。实时 OKX 集成单列，区分外部不可用和业务错误。
5. 提供本地 build → install → launch → smoke 命令：构建后替换 `/Applications/Perpetual Swap Suite.app`，从安装路径启动并验证当前 revision、窗口、preload、DuckDB、Worker 和正常退出。安装失败不得宣称交付完成，保留原 App 直至新产物校验通过。
6. CI 对真正打包的 `.app` executable 跑小型 smoke；现有源码目录 E2E 不能证明原生依赖和 Worker 已打进包。签名策略与文档保持一致，不将未要求的公证流程设为额外阻断条件。
7. 更新依赖前核验 registry 的稳定 dist-tag、Electron 与原生模块兼容性；锁定 Node/npm 支持范围和 lockfile。把 CLI/构建工具放 devDependencies，按实际使用删除过时组件、`Archive/StrategyChartReplay.swift` 等失效遗留和无引用依赖。
8. 已观测到 Streamdown 消息 chunk 约 1.09 MB、主 chunk 约 0.88 MB（压缩前）。在保留需要的渲染能力前提下裁剪插件/语言和延迟加载；用冷启动和内存数据判断收益，不为消除体积警告增加包装层。

**验收：** 非信任 frame、混合/无效命令无副作用；合法桌面行为正常；内部重命名不破坏行为测试。PR 能发现关键回归；发布产物和 `/Applications` 安装产物均通过 smoke，报告 revision 与测试结果。

## 测试与删除策略

测试只覆盖核心逻辑与关键功能，不设覆盖率指标。保留现有缺口、缓存修订、旧请求防覆盖、历史滚动和多合约切换测试；补齐独立数学期望、筛选边界、事务配置、实时确认生命周期、手动审计和安装产物这几个缺口。

优先删除以下被替代路径：列表独立指标重算、Log BB 默认字段与评分依赖、两套筛选/回填状态、webkit 兼容桥、无作用设置、已退役归档、组件私有视觉和固定旧实现字符串的断言。删除前检查实际引用；不因未在 AGENTS 列出就默认移除仍有用途的可选功能。

数据和公式版本变化时显式失效派生缓存；不承诺旧 API/旧字段兼容，也不无提示删除正确的历史市场数据或用户配置。需要一次性转换的用户数据采用明确离线步骤，不留下长期双读双写。

## 执行顺序与完成条件

建议按以上六阶段拆成可独立验收的提交。第一批只交付指标契约、独立黄金样本和列表/图表统一计算，先关闭 P0。配置与 CI 可并行；随后完成同步、筛选、实时和工作区。每个涉及代码的交付都必须完成 AGENTS 要求的 macOS 构建、替换及启动验证，再提交并推送主分支。

尚需在对应阶段定稿的业务口径包括：VWAP 定义、RSI 全平/零基线约定、排名使用完成价还是实时价、历史覆盖起点/保留范围、资格新鲜度和交互延迟预算。已有建议的事项在阶段内标明，其余在相应阶段定稿；这些决策不阻碍先复现和修复统一计算来源问题。

整体完成必须同时满足：规范对照表全部有行为证据，数学黄金样本通过，坏数据与中断恢复验证通过，双栏与缩放视觉验收通过，安装后的当前 revision App 可以正常运行。不能以旧测试全绿或安装包存在代替这些条件。

## 本次评估验证记录

- 本地验证环境为 macOS arm64、Node 22.21.0、npm 11.18.0；与 README 建议的 Node 24.11+ 不一致，尚不能代表受支持版本矩阵已验证。`npm ci --ignore-scripts` 完成；为运行 Electron E2E 单独执行 Electron 安装脚本。没有修改依赖清单或 lockfile。
- `npm run test:renderer`：136/136 通过。
- 生产构建 `npm run build`：通过；存在大 chunk 提示。
- `npm run lint`：通过，8 条 warning，其中含 App 的 ref/render、初始化引用和 effect dependency 警告；不是零告警基线。
- 基于已构建 renderer 执行 `node --test-concurrency=1 --test tests/e2e/*.e2e.mjs`：16/16 通过。测试启动源码 Electron，不代表安装产物已验证。
- `npx shadcn@latest info --json` 确认当前项目 base 为 Radix；`npm outdated --json` 报告 Electron 44.8.0 → 44.9.0、React/React DOM 19.3.0 → 19.3.1、shadcn 4.21.4 → 4.22.0。此为当次 registry 快照，实施时重新核验。
- `npm audit --json` 报告 23 项：7 low、8 moderate、8 high，包含传递依赖。需要按生产可达性与构建工具分类处理；不能据此直接声称运行时存在 8 个可利用高危漏洞，也不要直接运行 `audit fix --force`。
- 尚未运行 live OKX 集成、性能 benchmark、macOS 打包与安装验证；本次仅添加规划文档，没有产品代码变更。
- 已核对 [OKX Candlesticks](https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-candlesticks)：衍生品 `volCcy` 为基础币数量，`volCcyQuote` 为计价币数量，BTC-USDT-SWAP 对应 USDT；[Tickers](https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-tickers) 的 `volCcy24h` 为基础币数量，因此乘最新价是重估值。它们支持本计划的量纲整改，不能替代真实接口验证。
- [OI history](https://www.okx.com/docs-v5/en/#trading-statistics-rest-api-get-contract-open-interest-history) 和 [Contract taker volume](https://www.okx.com/docs-v5/en/#trading-statistics-rest-api-get-contract-taker-volume) 定义 OI contracts、Taker `unit=1` contracts，当前选择有官方依据；实现阶段仍需验证时间对齐、分页和可用历史边界，不把注释、fixture 或单次空响应当作永久不可用的证明。
