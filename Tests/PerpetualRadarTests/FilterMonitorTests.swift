import AppKit
import XCTest
@testable import PerpetualRadar

final class FilterMonitorTests: BackgroundTestCase {
    @MainActor
    func testLongNotificationsAggregateStrategiesAndPreserveDedupThroughUnknown() throws {
        let strategy = LongStrategy(name: "First", entryJSON: try FilterCompiler.compile(source: "Close > 0").config.json, exitJSON: try FilterCompiler.compile(source: "Close < 0").config.json)
        var other = strategy; other.id = "other"; other.name = "Second"
        func row(_ symbol: String, _ strategy: LongStrategy, _ action: String, id: String? = nil) -> LongDecisionRow {
            var position = LongTrackedPosition(strategyID: strategy.id, instrument: symbol, enteredAt: 1, entryPrice: 100, strategy: strategy)
            position.id = id ?? symbol
            return .init(instrument: symbol, hour: 1, entry: "unknown", exit: action == "Unknown" ? "unknown" : action == "Exit Long" ? "true" : "false", action: action, reason: "BTC crash", position: position)
        }
        let tracker = LongExitTracker()
        let hits = [LongExitObservation(strategy: strategy, rows: [row("ETH",strategy,"Exit Long"), row("SOL",strategy,"Exit Long")]), LongExitObservation(strategy: other, rows: [row("ETH",other,"Exit Long")])]
        let first = tracker.consume(hits)
        XCTAssertEqual(first.count, 2); XCTAssertEqual(first[0].instruments, ["ETH", "SOL"])
        XCTAssertTrue(tracker.consume(hits).isEmpty)
        var revision = hits; revision[0].strategy.revision += 1
        XCTAssertTrue(tracker.consume(revision).isEmpty, "Saving edits must not repeat a continuously satisfied exit notification.")
        let unknown = [LongExitObservation(strategy: strategy, rows: [row("ETH",strategy,"Unknown"), row("SOL",strategy,"Unknown")]), hits[1]]
        XCTAssertTrue(tracker.consume(unknown).isEmpty); XCTAssertTrue(tracker.consume(hits).isEmpty)
        let clear = [LongExitObservation(strategy: strategy, rows: [row("ETH",strategy,"Hold Long"), row("SOL",strategy,"Exit Long")]), hits[1]]
        XCTAssertTrue(tracker.consume(clear).isEmpty)
        XCTAssertEqual(tracker.consume(hits).first?.instruments, ["ETH"])
        let newPosition = [LongExitObservation(strategy: strategy, rows: [row("ETH",strategy,"Exit Long",id: "new-entry"), row("SOL",strategy,"Exit Long")]), hits[1]]
        XCTAssertEqual(tracker.consume(newPosition).first?.instruments, ["ETH"])
    }

    @MainActor
    func testRestartedMonitorRetainsLongNotificationMemoryUntilDefiniteRecovery() async throws {
        let strategy = LongStrategy(name: "BTC pause", entryJSON: try FilterCompiler.compile(source: "Close > 0").config.json, exitJSON: try FilterCompiler.compile(source: #"BTC(ROC(1), "live") <= -2"#).config.json)
        let position = LongTrackedPosition(strategyID: strategy.id, instrument: "ETH-USDT-SWAP", enteredAt: 1, entryPrice: 100, strategy: strategy)
        let tracker = LongExitTracker()
        var samples = 0, changes: [LongExitChange] = [], action = "Exit Long"
        func monitor() -> FilterMonitor {
            FilterMonitor(interval: .seconds(30), longTracker: tracker, sample: {
                samples += 1
                var observation = self.observation([:])
                observation.longExits = [.init(strategy: strategy, rows: [.init(instrument: position.instrument, hour: 1, entry: "unknown", exit: action == "Unknown" ? "unknown" : action == "Exit Long" ? "true" : "false", action: action, reason: "BTC crash", position: position)])]
                return observation
            }, onChanges: { _ in }, onLongExits: { changes += $0 })
        }
        func wait(_ target: Int) async throws {
            let deadline = Date().addingTimeInterval(2)
            while samples < target, Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
            try await Task.sleep(for: .milliseconds(10))
            XCTAssertEqual(samples, target)
        }
        let first = monitor(); first.start(); try await wait(1); first.stop()
        XCTAssertEqual(changes.count, 1)
        let resumed = monitor(); defer { resumed.stop() }
        action = "Unknown"; resumed.start(); try await wait(2)
        action = "Exit Long"; resumed.wake(); try await wait(3)
        XCTAssertEqual(changes.count, 1, "Pausing and resuming must not repeat a continuously triggered Long exit.")
        action = "Hold Long"; resumed.wake(); try await wait(4)
        action = "Exit Long"; resumed.wake(); try await wait(5)
        XCTAssertEqual(changes.count, 2)
    }

    @MainActor
    func testBTCWakeEvaluatesImmediatelyWithoutWaitingForFallbackPoll() async throws {
        var samples = 0, changes: [FilterMembershipChange] = []
        let monitor = FilterMonitor(interval: .seconds(30), sample: {
            samples += 1
            return self.observation(["ETH": samples == 1 ? .no : .yes])
        }, onChanges: { changes += $0 })
        defer { monitor.stop() }
        monitor.start()
        let deadline = Date().addingTimeInterval(2)
        while samples == 0, Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
        monitor.wake()
        while changes.isEmpty, Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(changes, [.init(instId: "ETH", direction: .entered)])
        XCTAssertEqual(samples, 2)
    }
    private func observation(_ results: [String: FilterTruth], configuration: String = "saved", universe: Set<String>? = nil) -> FilterObservation {
        .init(configuration: configuration, universe: universe ?? Set(results.keys), results: results)
    }

    func testStartupBaselinesRemainQuietWhileEachContractLoads() {
        var tracker = FilterMembershipTracker()
        XCTAssertEqual(tracker.consume(observation(["BTC": .yes, "ETH": .unknown, "SOL": .no])), [])
        XCTAssertEqual(tracker.consume(observation(["BTC": .yes, "ETH": .yes, "SOL": .no])), [])
        XCTAssertEqual(tracker.consume(observation(["BTC": .yes, "ETH": .yes, "SOL": .yes])), [.init(instId: "SOL", direction: .entered)])
    }

    func testEntryExitAndReentryAreReportedOncePerTransition() {
        var tracker = FilterMembershipTracker()
        _ = tracker.consume(observation(["BTC": .no]))
        XCTAssertEqual(tracker.consume(observation(["BTC": .yes])), [.init(instId: "BTC", direction: .entered)])
        XCTAssertEqual(tracker.consume(observation(["BTC": .yes])), [])
        XCTAssertEqual(tracker.consume(observation(["BTC": .no])), [.init(instId: "BTC", direction: .exited)])
        XCTAssertEqual(tracker.consume(observation(["BTC": .no])), [])
        XCTAssertEqual(tracker.consume(observation(["BTC": .yes])), [.init(instId: "BTC", direction: .entered)])
    }

    func testUnknownAndMissingReadingsPreserveMembershipThroughRecovery() {
        var tracker = FilterMembershipTracker()
        _ = tracker.consume(observation(["BTC": .yes, "ETH": .no]))
        XCTAssertEqual(tracker.consume(observation(["BTC": .unknown, "ETH": .unknown])), [])
        XCTAssertEqual(tracker.consume(observation([:], universe: ["BTC", "ETH"])), [])
        XCTAssertEqual(tracker.consume(observation(["BTC": .yes, "ETH": .no])), [])
        XCTAssertEqual(tracker.consume(observation(["BTC": .no, "ETH": .yes])), [
            .init(instId: "BTC", direction: .exited), .init(instId: "ETH", direction: .entered),
        ])
    }

    func testSavedRuleChangesEstablishANewQuietBaseline() {
        var tracker = FilterMembershipTracker()
        _ = tracker.consume(observation(["BTC": .yes, "ETH": .no]))
        XCTAssertEqual(tracker.consume(observation(["BTC": .no, "ETH": .unknown], configuration: "new saved rules")), [])
        XCTAssertEqual(tracker.consume(observation(["BTC": .no, "ETH": .yes], configuration: "new saved rules")), [])
        XCTAssertEqual(tracker.consume(observation(["BTC": .yes, "ETH": .no], configuration: "new saved rules")), [
            .init(instId: "BTC", direction: .entered), .init(instId: "ETH", direction: .exited),
        ])
    }

    func testNewListingsNotifyWhenTheyResolveAndRemovalNotifiesOnlyMatchedMarkets() {
        var tracker = FilterMembershipTracker()
        _ = tracker.consume(observation(["BTC": .yes]))
        XCTAssertEqual(tracker.consume(observation(["BTC": .yes, "NEW": .unknown, "OTHER": .no])), [])
        XCTAssertEqual(tracker.consume(observation(["BTC": .yes, "NEW": .yes, "OTHER": .no])), [.init(instId: "NEW", direction: .entered)])
        XCTAssertEqual(tracker.consume(observation(["NEW": .yes])), [.init(instId: "BTC", direction: .exited)])
        XCTAssertEqual(tracker.consume(observation(["NEW": .yes])), [])
        XCTAssertEqual(tracker.consume(observation(["NEW": .yes, "BTC": .yes])), [.init(instId: "BTC", direction: .entered)])
        XCTAssertEqual(tracker.consume(observation([:])), [
            .init(instId: "BTC", direction: .exited), .init(instId: "NEW", direction: .exited),
        ])
    }

    @MainActor
    func testNativeMonitoringContinuesAfterClosingWindowRecoversFromErrorsAndStopsOnQuit() async throws {
        // The native test runner isolates this explicit background-mode case
        // from the user's default on-demand app preferences.
        let defaults = MonitorRuntime.defaults, previousMode = MonitorRuntime.defaults.object(forKey: "BackgroundMonitoring")
        defaults.set(true, forKey: "BackgroundMonitoring")
        let app = NSApplication.shared, delegate = AppDelegate()
        app.setActivationPolicy(.accessory)
        let window = BackgroundTestWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 200),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.delegate = delegate
        let previousPreference = MonitorRuntime.defaults.object(forKey: AppUpdater.backgroundRelaunchKey)
        window.orderBack(nil)
        XCTAssertTrue(window.isVisible)
        var samples = 0, changes: [FilterMembershipChange] = [], errors: [String] = [], longChanges: [LongExitChange] = []
        let strategy = LongStrategy(name: "Closed-window BTC", entryJSON: try FilterCompiler.compile(source: "Close > 0").config.json, exitJSON: try FilterCompiler.compile(source: #"BTC(ROC(1), "live") <= -2"#).config.json)
        let position = LongTrackedPosition(strategyID: strategy.id,instrument: "ETH-USDT-SWAP",enteredAt: 1,entryPrice: 100,strategy: strategy)
        let monitor = FilterMonitor(interval: .milliseconds(10), sample: {
            samples += 1
            if samples == 2 { throw FilterError("Temporary collector failure") }
            var observation = self.observation(["BTC": samples < 3 ? .no : .yes])
            observation.longExits = [.init(strategy: strategy, rows: [.init(instrument: position.instrument,hour: 1,entry: "unknown",exit: samples < 3 ? "false" : "true",action: samples < 3 ? "Hold Long" : "Exit Long",reason: "BTC crash",position: position,btcExit: true)])]
            return observation
        }, onChanges: { changes += $0 }, onLongExits: { longChanges += $0 }, onError: { errors.append($0) })
        defer {
            monitor.stop(); window.delegate = nil; window.close()
            defaults.set(previousPreference, forKey: AppUpdater.backgroundRelaunchKey)
            defaults.set(previousMode, forKey: "BackgroundMonitoring")
        }
        monitor.start(); monitor.start()
        let firstSampleDeadline = Date().addingTimeInterval(3)
        while samples < 1, Date() < firstSampleDeadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertGreaterThan(samples, 0)
        window.performClose(nil)
        XCTAssertFalse(window.isVisible)
        XCTAssertFalse(delegate.applicationShouldTerminateAfterLastWindowClosed(app))
        let deadline = Date().addingTimeInterval(3)
        while changes.isEmpty, Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(changes, [.init(instId: "BTC", direction: .entered)])
        XCTAssertEqual(longChanges.count, 1); XCTAssertEqual(longChanges.first?.instruments, [position.instrument])
        XCTAssertTrue(errors.contains { $0.contains("Temporary collector failure") })
        XCTAssertEqual(errors.last, "")
        monitor.stop()
        let stoppedAt = samples
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(samples, stoppedAt)
    }

    func testUniverseIncludesOnlyLiveNonTradFiUSDTPerpetualSwaps() {
        let valid: [String: Any] = ["instId": "BTC-USDT-SWAP", "state": "live", "instCategory": "1", "settleCcy": "USDT", "listTime": "123"]
        var tradFi = valid; tradFi["instId"] = "XAU-USDT-SWAP"; tradFi["instCategory"] = "2"
        var halted = valid; halted["instId"] = "HALT-USDT-SWAP"; halted["state"] = "suspend"
        var otherSettlement = valid; otherSettlement["instId"] = "BTC-USD-SWAP"; otherSettlement["settleCcy"] = "USD"
        var future = valid; future["instId"] = "BTC-USDT-261225"
        var missingAge = valid; missingAge["instId"] = "NEW-USDT-SWAP"; missingAge["listTime"] = "0"
        XCTAssertEqual(liveUSDTInstruments([valid, tradFi, halted, otherSettlement, future, missingAge]), [
            "BTC-USDT-SWAP": SwapInstrument(id: "BTC-USDT-SWAP", listedAt: 123),
            "NEW-USDT-SWAP": SwapInstrument(id: "NEW-USDT-SWAP", listedAt: nil),
        ])
    }
}
