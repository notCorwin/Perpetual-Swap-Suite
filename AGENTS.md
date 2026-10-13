# Perpetual Swap Suite
1. 合约范围：OKX 所有非 TradFi 的 USDT 永续合约。
2. 分析周期：5分钟，15分钟，1 小时。
3. 界面语言：English Only。
合约价格可能呈现以下周期性演化：
Bullish Setup（上涨蓄势）→ Uptrend（上升趋势）→ Overextension（趋势过热）→ Bullish Exhaustion（上涨动能衰竭）→ Bearish Reversal（看跌反转）→ Downtrend（下降趋势）→ Bearish Exhaustion（下跌动能衰竭）。
此交易策略的关键点在识别不同市场阶段的转换：在上涨蓄势阶段寻找做多机会，在上涨动能衰竭时平多；待看跌反转得到确认后建立空头仓位，并在下跌动能衰竭或新一轮上涨蓄势形成时平空，完成一轮多空交易周期。
## 需求
用户自定义规则，判断什么情况下是 Bullish Setup / Bearish Reversal，支持实时捕捉合约 + 策略回测，提高盈利率和胜率。
1. Radar Mode 雷达模式：专注于捕捉处于 Bullish Setup / Bearish Reversal 状态的永续合约。
2. Research Mode 研究模式：通过不断改进规则，提高胜率与盈亏比。
3. Trade Mode 交易模式（Future Feature，不要 Implement）：基于自定义规则，实时全自动化通过 OKX API 交易。
Radar、Research、Trade 的策略同步，但如果用户想，可以复制互通。
## 技术栈
Swift、AppKit、WebKit、shadcn/ui、Tailwind CSS、WebSocket。
## UI / UX
1. 表头公式统一使用 HTML 渲染，不使用 KaTeX / LaTeX。
2. 在所有地方应用等宽数字。
3. 界面必须兼顾色弱与色盲用户，通过互补色提升可读性；整体采用现代配色，Light Mode 与 Dark Mode 可分别使用独立配色方案。涨跌配色采用绿涨红跌：
	   1. 红色：`RGB(232, 85, 168)`
	   2. 绿色（浅色模式）：`RGB(142, 188, 57)`
	   3. 绿色（深色模式）：`RGB(202, 253, 92)`
## 特殊要求
1. 系统级功能、窗口管理、数据存储、网络通信等能力优先使用 Swift 与 macOS 原生 API 实现。
2. 应用在视觉与交互上必须表现为 macOS 原生应用，不得呈现传统网页或浏览器式体验。
3. Chart 中的数值标签应作为折线本身的一部分显示在线条右侧，而不是作为独立坐标轴标签。
4. UI 应自动在水平方向上撑满 App 窗口，以完整设计宽度为基准；当 App 窗口宽度不足时，整体按比例缩放，而不是改变原有布局结构。
5. 把 Signed Relative Change 用于大部分变化率的计算（用百分比格式展示）。
6. 已经确认的数据持久化存储于本地；运行时动态数据仅保留在内存中。
