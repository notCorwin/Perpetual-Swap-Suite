import Foundation

struct BrokerTick: Hashable, Sendable {
    let timestamp: Int64
    let price: Double
    let cumulativeVolumeFraction: Double
    let isOpen: Bool
    let isClose: Bool
}

enum TradingViewPath {
    static func ticks(for candle: Candle) -> [BrokerTick] {
        let highFirst = abs(candle.open - candle.high) < abs(candle.open - candle.low)
        let prices = highFirst
            ? [candle.open, candle.high, candle.low, candle.close]
            : [candle.open, candle.low, candle.high, candle.close]
        let offsets: [Int64] = [0, 100_000, 200_000, 299_999]
        return prices.enumerated().map { index, price in
            .init(
                timestamp: candle.timestamp + offsets[index], price: price,
                cumulativeVolumeFraction: Double(index + 1) / 4,
                isOpen: index == 0, isClose: index == 3
            )
        }
    }
}

struct BacktestEngine: Sendable {
    typealias StrategyExecutor = @Sendable (StrategyEvent) async throws -> [StrategyCommand]

    func run(
        request: BacktestRequest,
        instrument: Instrument,
        settings: AppSettings,
        candles: [Candle],
        funding: [FundingPoint] = [],
        execute: StrategyExecutor
    ) async throws -> BacktestReport {
        let started = ContinuousClock.now
        var simulation = Simulation(request: request, instrument: instrument, settings: settings, fundingPoints: funding)
        let source = candles.filter(\.confirmed).sorted { $0.timestamp < $1.timestamp }
        guard !source.isEmpty else { throw BacktestError.noData }

        for candle in source {
            let bucket = candle.timestamp / request.timeframe.milliseconds * request.timeframe.milliseconds
            if simulation.bar?.timestamp != bucket {
                simulation.bar = StrategyBar(
                    timestamp: bucket, open: candle.open, high: candle.open, low: candle.open,
                    close: candle.open, volume: 0, confirmed: false
                )
            }
            for tick in TradingViewPath.ticks(for: candle) {
                simulation.sequence += 1
                simulation.updateBar(candle: candle, tick: tick)
                simulation.applyFunding(through: tick.timestamp, price: tick.price)
                let fills = simulation.processOrders(at: tick)
                simulation.checkLiquidation(at: tick)
                simulation.markToMarket(price: tick.price, timestamp: tick.timestamp)

                if request.execution.onOrderFill && fills > 0 {
                    try await evaluate(reason: .orderFill, simulation: &simulation, execute: execute)
                }
                let chartCloses = tick.isClose && candle.timestamp + Timeframe.fiveMinutes.milliseconds == bucket + request.timeframe.milliseconds
                if request.execution.onHistoryTick {
                    if chartCloses { simulation.bar?.confirmed = true }
                    try await evaluate(reason: chartCloses ? .barClose : .historyTick, simulation: &simulation, execute: execute)
                } else if chartCloses {
                    simulation.bar?.confirmed = true
                    try await evaluate(reason: .barClose, simulation: &simulation, execute: execute)
                }
                if chartCloses && request.execution.processOrdersOnClose {
                    _ = simulation.processOrders(at: tick, allowCurrentSequence: true, marketOnly: true)
                }
                simulation.previousPrice = tick.price
            }
        }
        simulation.closeAtEnd(timestamp: source.last!.timestamp + Timeframe.fiveMinutes.milliseconds - 1, price: source.last!.close)
        let elapsed = started.duration(to: .now)
        return simulation.report(elapsedMS: Int64(elapsed.components.seconds * 1_000) + Int64(elapsed.components.attoseconds / 1_000_000_000_000_000))
    }

    private func evaluate(reason: StrategyEvent.Reason, simulation: inout Simulation, execute: StrategyExecutor) async throws {
        guard let event = simulation.event(reason: reason) else { return }
        let commands = try await execute(event)
        simulation.apply(commands: commands)
    }
}

private struct Simulation {
    struct Order {
        var id: String
        var side: OrderSide
        var kind: OrderKind
        var quantity: Double
        var marginUSDT: Double?
        var leverage: Double
        var limitPrice: Double?
        var stopPrice: Double?
        var stopActivated = false
        var reduceOnly: Bool
        var ocaGroup: String?
        var eligibleSequence: Int
        var reason: String
    }

    struct Position {
        var id: String
        var direction: StrategyDirection
        var quantity: Double
        var entryPrice: Double
        var entryAt: Int64
        var leverage: Double
        var entryFee: Double
        var funding: Double
        var adversePercent = 0.0
        var favorablePercent = 0.0
    }

    let request: BacktestRequest
    let instrument: Instrument
    let settings: AppSettings
    var bar: StrategyBar?
    var sourceVolumeBase = 0.0
    var sequence = 0
    var previousPrice: Double?
    var orders = [String: Order]()
    var position: Position?
    var cash: Double
    var fees = 0.0
    var funding = 0.0
    var trades = [BacktestTrade]()
    var markers = [BacktestMarker]()
    var peakEquity: Double
    var maximumDrawdownPercent = 0.0
    var lastPrice = 0.0
    var lastTimestamp: Int64 = 0
    let fundingPoints: [FundingPoint]
    var fundingIndex = 0

    init(request: BacktestRequest, instrument: Instrument, settings: AppSettings, fundingPoints: [FundingPoint]) {
        self.request = request
        self.instrument = instrument
        self.settings = settings
        self.fundingPoints = fundingPoints.sorted { $0.timestamp < $1.timestamp }
        cash = settings.initialCapitalUSDT
        peakEquity = settings.initialCapitalUSDT
    }

    mutating func applyFunding(through timestamp: Int64, price: Double) {
        while fundingIndex < fundingPoints.count, fundingPoints[fundingIndex].timestamp <= timestamp {
            let point = fundingPoints[fundingIndex]
            fundingIndex += 1
            guard var current = position, point.timestamp >= current.entryAt else { continue }
            let notional = current.quantity * instrument.contractValue * price
            let payment = notional * point.rate * (current.direction == .long ? 1 : -1)
            cash -= payment
            funding += payment
            current.funding += payment
            position = current
        }
    }

    mutating func updateBar(candle: Candle, tick: BrokerTick) {
        guard var current = bar else { return }
        current.high = max(current.high, tick.price)
        current.low = min(current.low, tick.price)
        current.close = tick.price
        if tick.isOpen { sourceVolumeBase = current.volume }
        current.volume = sourceVolumeBase + candle.volumeContracts * tick.cumulativeVolumeFraction
        current.confirmed = false
        bar = current
        lastPrice = tick.price
        lastTimestamp = tick.timestamp
    }

    mutating func apply(commands: [StrategyCommand]) {
        for command in commands {
            switch command.action {
            case .cancel:
                if let id = command.id { orders.removeValue(forKey: id) }
            case .cancelAll: orders.removeAll()
            case .amend:
                guard let id = command.id, var order = orders[id] else { continue }
                if let quantity = command.quantity { order.quantity = quantity }
                if let limit = command.limitPrice { order.limitPrice = limit }
                if let stop = command.stopPrice { order.stopPrice = stop }
                orders[id] = order
            case .close:
                guard let position else { continue }
                let side: OrderSide = position.direction == .long ? .sell : .buy
                place(command: command, id: command.id ?? "close", side: side, direction: nil, forceReduce: true, quantity: position.quantity, reason: "Strategy close")
            case .exit:
                guard let position else { continue }
                let side: OrderSide = position.direction == .long ? .sell : .buy
                place(command: command, id: command.id ?? "exit", side: side, direction: nil, forceReduce: true, quantity: command.quantity ?? position.quantity, reason: "Strategy exit")
            case .entry:
                guard position == nil, let direction = command.direction else { continue }
                let side: OrderSide = direction == .long ? .buy : .sell
                place(command: command, id: command.id ?? "entry", side: side, direction: direction, forceReduce: false, quantity: command.quantity, reason: "Strategy entry")
            case .order:
                let direction = command.direction
                let side = command.side ?? direction.map { $0 == .long ? .buy : .sell }
                guard let side else { continue }
                place(command: command, id: command.id ?? "order-\(sequence)", side: side, direction: direction, forceReduce: command.reduceOnly ?? false, quantity: command.quantity, reason: "Strategy order")
            }
        }
    }

    private mutating func place(
        command: StrategyCommand, id: String, side: OrderSide, direction: StrategyDirection?,
        forceReduce: Bool, quantity requestedQuantity: Double?, reason: String
    ) {
        let leverage = min(max(command.leverage ?? settings.leverage, 1), 125)
        let quantity: Double
        if let requestedQuantity { quantity = requestedQuantity }
        else if forceReduce, let position { quantity = position.quantity }
        else {
            let margin = command.marginUSDT ?? settings.initialCapitalUSDT
            quantity = margin * leverage / max(lastPrice * instrument.contractValue, instrument.tickSize)
        }
        guard quantity > 0 else { return }
        let kind = command.type ?? {
            if command.stopPrice != nil && command.limitPrice != nil { return .stopLimit }
            if command.stopPrice != nil { return .stop }
            if command.limitPrice != nil { return .limit }
            return .market
        }()
        orders[id] = Order(
            id: id, side: side, kind: kind, quantity: quantity,
            marginUSDT: command.marginUSDT, leverage: leverage,
            limitPrice: command.limitPrice, stopPrice: command.stopPrice,
            reduceOnly: forceReduce, ocaGroup: command.ocaGroup,
            eligibleSequence: sequence + 1, reason: reason
        )
        _ = direction
    }

    mutating func processOrders(at tick: BrokerTick, allowCurrentSequence: Bool = false, marketOnly: Bool = false) -> Int {
        let eligible = orders.values.filter { order in
            (allowCurrentSequence ? order.eligibleSequence <= sequence + 1 : order.eligibleSequence <= sequence)
                && (!marketOnly || order.kind == .market)
        }.sorted { lhs, rhs in
            if lhs.reduceOnly != rhs.reduceOnly { return lhs.reduceOnly && !rhs.reduceOnly }
            return lhs.id < rhs.id
        }
        var fills = 0
        for var order in eligible {
            guard orders[order.id] != nil else { continue }
            if order.reduceOnly && position == nil { continue }
            guard let fillPrice = fillPrice(order: &order, tick: tick) else {
                orders[order.id] = order
                continue
            }
            orders.removeValue(forKey: order.id)
            fill(order: order, price: fillPrice, timestamp: tick.timestamp)
            fills += 1
            if let group = order.ocaGroup {
                orders = orders.filter { $0.value.ocaGroup != group }
            }
        }
        return fills
    }

    private func fillPrice(order: inout Order, tick: BrokerTick) -> Double? {
        let previous = previousPrice ?? tick.price
        let low = min(previous, tick.price)
        let high = max(previous, tick.price)
        let slippage = Double(settings.slippageTicks) * instrument.tickSize
        switch order.kind {
        case .market: return tick.price + (order.side == .buy ? slippage : -slippage)
        case .limit:
            guard let limit = order.limitPrice else { return nil }
            let verification = Double(request.execution.verifyLimitTicks) * instrument.tickSize
            let reached = order.side == .buy ? low <= limit - verification : high >= limit + verification
            guard reached else { return nil }
            if tick.isOpen && (order.side == .buy ? tick.price < limit : tick.price > limit) { return tick.price }
            return limit
        case .stop:
            guard let stop = order.stopPrice else { return nil }
            let reached = order.side == .buy ? high >= stop : low <= stop
            guard reached else { return nil }
            if tick.isOpen && (order.side == .buy ? tick.price > stop : tick.price < stop) { return tick.price + (order.side == .buy ? slippage : -slippage) }
            return stop + (order.side == .buy ? slippage : -slippage)
        case .stopLimit:
            if !order.stopActivated, let stop = order.stopPrice {
                order.stopActivated = order.side == .buy ? high >= stop : low <= stop
            }
            guard order.stopActivated, let limit = order.limitPrice else { return nil }
            let reached = order.side == .buy ? low <= limit : high >= limit
            return reached ? limit : nil
        }
    }

    private mutating func fill(order: Order, price: Double, timestamp: Int64) {
        var quantity = order.reduceOnly ? min(order.quantity, position?.quantity ?? 0) : order.quantity
        guard quantity > 0 else { return }
        var notional = quantity * instrument.contractValue * price
        if !order.reduceOnly, order.marginUSDT != nil, notional / order.leverage > cash {
            quantity = cash * order.leverage / max(instrument.contractValue * price, instrument.tickSize)
            notional = quantity * instrument.contractValue * price
        }
        let fee = notional * settings.takerFeePercent / 100

        if order.reduceOnly, let current = position {
            fees += fee
            cash -= fee
            closePosition(current, quantity: quantity, price: price, timestamp: timestamp, exitFee: fee, reason: order.reason, liquidated: false)
            return
        }
        guard position == nil else { return }
        let margin = notional / order.leverage
        guard margin <= cash else { return }
        fees += fee
        cash -= fee
        let direction: StrategyDirection = order.side == .buy ? .long : .short
        position = Position(
            id: order.id, direction: direction, quantity: quantity, entryPrice: price,
            entryAt: timestamp, leverage: order.leverage, entryFee: fee, funding: 0
        )
        markers.append(.init(timestamp: timestamp, price: price, kind: direction.rawValue, label: direction == .long ? "Long" : "Short"))
        installRiskOrders(for: position!)
    }

    private mutating func installRiskOrders(for position: Position) {
        let takeMove = settings.takeProfitMarginPercent / 100 / position.leverage
        let stopMove = settings.stopLossMarginPercent / 100 / position.leverage
        let side: OrderSide = position.direction == .long ? .sell : .buy
        let take = position.entryPrice * (position.direction == .long ? 1 + takeMove : 1 - takeMove)
        let stop = position.entryPrice * (position.direction == .long ? 1 - stopMove : 1 + stopMove)
        orders["__risk_take"] = Order(
            id: "__risk_take", side: side, kind: .limit, quantity: position.quantity, marginUSDT: nil,
            leverage: position.leverage, limitPrice: take, stopPrice: nil, reduceOnly: true,
            ocaGroup: "__risk", eligibleSequence: sequence + 1, reason: "Take profit"
        )
        orders["__risk_stop"] = Order(
            id: "__risk_stop", side: side, kind: .stop, quantity: position.quantity, marginUSDT: nil,
            leverage: position.leverage, limitPrice: nil, stopPrice: stop, reduceOnly: true,
            ocaGroup: "__risk", eligibleSequence: sequence + 1, reason: "Stop loss"
        )
    }

    mutating func checkLiquidation(at tick: BrokerTick) {
        guard let current = position else { return }
        let baseQuantity = current.quantity * instrument.contractValue
        let maintenance = 0.005
        let liquidationPrice: Double
        if current.direction == .long {
            liquidationPrice = (current.entryPrice * baseQuantity - cash) / max(baseQuantity * (1 - maintenance), .leastNonzeroMagnitude)
            guard tick.price <= liquidationPrice else { return }
        } else {
            liquidationPrice = (cash + current.entryPrice * baseQuantity) / max(baseQuantity * (1 + maintenance), .leastNonzeroMagnitude)
            guard tick.price >= liquidationPrice else { return }
        }
        let price = max(instrument.tickSize, liquidationPrice)
        let fee = current.quantity * instrument.contractValue * price * settings.takerFeePercent / 100
        fees += fee
        cash -= fee
        closePosition(current, quantity: current.quantity, price: price, timestamp: tick.timestamp, exitFee: fee, reason: "Liquidation", liquidated: true)
        orders.removeAll()
    }

    private mutating func closePosition(
        _ current: Position, quantity: Double, price: Double, timestamp: Int64,
        exitFee: Double, reason: String, liquidated: Bool
    ) {
        let direction = current.direction == .long ? 1.0 : -1.0
        let gross = (price - current.entryPrice) * current.quantity * instrument.contractValue * direction
        cash += gross
        let allocatedEntryFee = current.entryFee * (quantity / current.quantity)
        let net = gross - allocatedEntryFee - exitFee - current.funding
        let margin = current.entryPrice * current.quantity * instrument.contractValue / current.leverage
        trades.append(.init(
            id: current.id, direction: current.direction, entryAt: current.entryAt, exitAt: timestamp,
            entryPrice: current.entryPrice, exitPrice: price, quantityContracts: current.quantity,
            grossPnLUSDT: gross, feesUSDT: allocatedEntryFee + exitFee, fundingUSDT: current.funding,
            netPnLUSDT: net, returnOnMarginPercent: margin == 0 ? 0 : net / margin * 100,
            durationMS: timestamp - current.entryAt, maximumAdverseExcursionPercent: current.adversePercent,
            maximumFavorableExcursionPercent: current.favorablePercent, exitReason: reason, liquidated: liquidated
        ))
        markers.append(.init(timestamp: timestamp, price: price, kind: liquidated ? "liquidation" : "exit", label: reason))
        position = nil
        orders = orders.filter { !$0.value.reduceOnly }
    }

    mutating func markToMarket(price: Double, timestamp: Int64) {
        lastPrice = price
        if var current = position {
            let move = signedRelativeChange(current: price, baseline: current.entryPrice) * (current.direction == .long ? 1 : -1)
            current.favorablePercent = max(current.favorablePercent, move)
            current.adversePercent = min(current.adversePercent, move)
            position = current
        }
        let value = equity(price: price)
        peakEquity = max(peakEquity, value)
        if peakEquity > 0 { maximumDrawdownPercent = max(maximumDrawdownPercent, (peakEquity - value) / peakEquity * 100) }
        _ = timestamp
    }

    func event(reason: StrategyEvent.Reason) -> StrategyEvent? {
        guard let bar else { return nil }
        return .init(
            reason: reason, instrument: instrument.id, timeframe: request.timeframe,
            timestamp: lastTimestamp, price: lastPrice, bar: bar,
            position: position.map { current in
                let pnl = unrealized(current, price: lastPrice)
                return .init(
                    direction: current.direction, quantityContracts: current.quantity,
                    entryPrice: current.entryPrice, leverage: current.leverage,
                    unrealizedPnLUSDT: pnl,
                    marginUSDT: current.entryPrice * current.quantity * instrument.contractValue / current.leverage
                )
            },
            account: .init(
                balanceUSDT: cash, equityUSDT: equity(price: lastPrice),
                availableUSDT: max(0, cash - (position.map { $0.entryPrice * $0.quantity * instrument.contractValue / $0.leverage } ?? 0)),
                feesUSDT: fees, fundingUSDT: funding
            ),
            settings: settings
        )
    }

    mutating func closeAtEnd(timestamp: Int64, price: Double) {
        guard let current = position else { return }
        let fee = current.quantity * instrument.contractValue * price * settings.takerFeePercent / 100
        fees += fee
        cash -= fee
        closePosition(current, quantity: current.quantity, price: price, timestamp: timestamp, exitFee: fee, reason: "End of range", liquidated: false)
    }

    func report(elapsedMS: Int64) -> BacktestReport {
        let wins = trades.filter { $0.netPnLUSDT > 0 }.count
        let losses = trades.filter { $0.netPnLUSDT <= 0 }.count
        let initial = settings.initialCapitalUSDT
        let sorted = trades.sorted { $0.durationMS > $1.durationMS }
        return .init(
            strategyID: request.strategyID, instrument: request.instrument, timeframe: request.timeframe,
            from: request.from, through: request.through, initialCapitalUSDT: initial,
            finalEquityUSDT: cash, netProfitUSDT: cash - initial,
            returnPercent: initial == 0 ? 0 : (cash - initial) / initial * 100,
            winRatePercent: trades.isEmpty ? 0 : Double(wins) / Double(trades.count) * 100,
            maximumDrawdownPercent: maximumDrawdownPercent, totalTrades: trades.count,
            winningTrades: wins, losingTrades: losses,
            liquidations: trades.filter(\.liquidated).count, trades: sorted, markers: markers,
            warnings: ["5m OHLC broker emulation does not model queue position or historical order-book capacity."]
                + (fundingPoints.isEmpty ? ["Historical funding is shown as zero until the local funding series covers the selected range."] : []),
            elapsedMS: elapsedMS
        )
    }

    private func unrealized(_ position: Position, price: Double) -> Double {
        (price - position.entryPrice) * position.quantity * instrument.contractValue * (position.direction == .long ? 1 : -1)
    }

    private func equity(price: Double) -> Double { cash + (position.map { unrealized($0, price: price) } ?? 0) }
}

enum BacktestError: LocalizedError {
    case noData, instrumentUnavailable
    var errorDescription: String? {
        switch self {
        case .noData: "No completed 5m candles are available for this backtest range."
        case .instrumentUnavailable: "The selected contract metadata is unavailable."
        }
    }
}
