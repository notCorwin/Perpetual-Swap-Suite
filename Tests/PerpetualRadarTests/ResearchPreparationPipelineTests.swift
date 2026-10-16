import XCTest
import Darwin
@testable import PerpetualRadar

private actor PipelineProbe {
    private var downloadsReleased = false, importsReleased = false, finishesReleased = false
    private var downloading = 0, importing = 0, peakDownloads = 0, peakImports = 0
    private var acquired = 0, imported = 0, completed = Set<String>(), slots = Set<Int>()
    private var finalizing = 0
    func releaseDownloads() { downloadsReleased = true }
    func releaseImports() { importsReleased = true }
    func releaseFinishes() { finishesReleased = true }
    func acquire(_ source: ResearchSource) async throws -> ResearchSource {
        downloading += 1; peakDownloads = max(peakDownloads, downloading)
        defer { downloading -= 1 }
        while !downloadsReleased { try await Task.sleep(for: .milliseconds(2)) }
        acquired += 1
        return source
    }
    func prepare(_ slot: Int) async throws -> Double {
        importing += 1; peakImports = max(peakImports, importing); slots.insert(slot)
        defer { importing -= 1 }
        while !importsReleased { try await Task.sleep(for: .milliseconds(2)) }
        imported += 1
        return 1
    }
    func receive(_ source: ResearchSource) { completed.insert(source.id) }
    func finish(_ elapsed: Double) async throws -> Double {
        finalizing += 1
        defer { finalizing -= 1 }
        while !finishesReleased { try await Task.sleep(for: .milliseconds(2)) }
        return elapsed
    }
    func counts() -> (downloads: Int, imports: Int, peakDownloads: Int, peakImports: Int, acquired: Int, completed: Int, slots: Int, finalizing: Int, imported: Int) {
        (downloading, importing, peakDownloads, peakImports, acquired, completed.count, slots.count, finalizing, imported)
    }
}

final class ResearchPreparationPipelineTests: XCTestCase {
    private func sources(instruments: Int, files: Int) -> [ResearchSource] {
        (0..<instruments).flatMap { instrument in
            (0..<files).map { file in
                ResearchSource(id: "\(instrument)-\(file)", instrument: "TEST\(instrument)-USDT-SWAP", kind: "candle",
                               from: ResearchFixture.hour, through: ResearchFixture.hour,
                               url: "https://fixture.test/\(instrument)/\(file)", filename: "\(file).zip", archive: true)
            }
        }
    }
    func testEverySWAPDownloadsTogetherAndAdvancesWhileAllCPUImportSlotsAreBusy() async throws {
        let cores = ResearchLocalScan.concurrency, swaps = cores * 2 + 1
        let sources = sources(instruments: swaps, files: 3), probe = PipelineProbe()
        let task = Task {
            try await ResearchPreparationPipeline.run(sources, concurrency: cores, acquire: { _, source in
                try await probe.acquire(source)
            }, importSource: { slot, _ in
                try await probe.prepare(slot)
            }, finish: { _, _, elapsed, _ in try await probe.finish(elapsed) }, receive: { source, _ in await probe.receive(source) })
        }
        defer { task.cancel() }
        let deadline = ContinuousClock.now + .seconds(2)
        while await probe.counts().downloads < swaps, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(2)) }
        let downloading = await probe.counts()
        XCTAssertEqual(downloading.downloads, swaps, "Every SWAP must connect before any download is released.")
        await probe.releaseDownloads()
        while await probe.counts().acquired < sources.count, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(2)) }
        while await probe.counts().imports < cores, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(2)) }
        let blocked = await probe.counts()
        XCTAssertEqual(blocked.acquired, sources.count, "Downloads must advance while imports are waiting.")
        XCTAssertEqual(blocked.imports, cores); XCTAssertEqual(blocked.peakImports, cores)
        XCTAssertEqual(blocked.slots, cores); XCTAssertEqual(blocked.completed, 0)
        await probe.releaseImports()
        while ContinuousClock.now < deadline {
            let counts = await probe.counts()
            if counts.imported == sources.count, counts.finalizing == swaps { break }
            try await Task.sleep(for: .milliseconds(2))
        }
        let recovering = await probe.counts()
        XCTAssertEqual(recovering.imports, 0)
        XCTAssertEqual(recovering.imported, sources.count, "REST repair must not occupy slots needed by queued imports.")
        XCTAssertEqual(recovering.finalizing, swaps, "Every SWAP repairs independently while parser slots remain free for queued imports.")
        XCTAssertEqual(recovering.completed, 0)
        await probe.releaseFinishes()
        try await task.value
        let finished = await probe.counts()
        XCTAssertEqual(finished.completed, sources.count)
        XCTAssertEqual(finished.downloads, 0); XCTAssertEqual(finished.imports, 0)
    }

    func testCancellationDrainsEveryConcurrentDownloadWithoutWaitingForNetworkRelease() async throws {
        let swaps = ResearchLocalScan.concurrency * 2 + 1, probe = PipelineProbe()
        let inputs = sources(instruments: swaps, files: 2)
        let task = Task {
            try await ResearchPreparationPipeline.run(inputs, concurrency: ResearchLocalScan.concurrency, acquire: { _, source in
                try await probe.acquire(source)
            }, importSource: { slot, _ in try await probe.prepare(slot) }, finish: { _, _, elapsed, _ in try await probe.finish(elapsed) }, receive: { source, _ in await probe.receive(source) })
        }
        defer { task.cancel() }
        let deadline = ContinuousClock.now + .seconds(2)
        while await probe.counts().downloads < swaps, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(2)) }
        let active = await probe.counts(); XCTAssertEqual(active.downloads, swaps)
        let started = ContinuousClock.now
        task.cancel()
        do { try await task.value; XCTFail("Cancellation must stop the pipeline.") } catch is CancellationError {} catch { XCTFail("Unexpected error: \(error)") }
        XCTAssertLessThan(started.duration(to: .now), .milliseconds(500))
        let stopped = await probe.counts()
        XCTAssertEqual(stopped.downloads, 0); XCTAssertEqual(stopped.imports, 0)
        XCTAssertEqual(stopped.acquired, 0); XCTAssertEqual(stopped.completed, 0)
    }

    func testEverySWAPCanKeepItsFileOpenBeyondTheGUIProcessDescriptorLimit() async throws {
        var original = rlimit()
        XCTAssertEqual(getrlimit(RLIMIT_NOFILE, &original), 0)
        var reduced = original; reduced.rlim_cur = 256
        XCTAssertEqual(setrlimit(RLIMIT_NOFILE, &reduced), 0)
        defer { XCTAssertEqual(setrlimit(RLIMIT_NOFILE, &original), 0) }
        let swaps = 300, probe = PipelineProbe(), inputs = sources(instruments: 300, files: 1)
        let task = Task {
            try await ResearchPreparationPipeline.run(inputs, concurrency: ResearchLocalScan.concurrency, acquire: { _, source in
                let file = try FileHandle(forWritingTo: URL(fileURLWithPath: "/dev/null"))
                defer { try? file.close() }
                return try await probe.acquire(source)
            }, importSource: { slot, _ in try await probe.prepare(slot) }, finish: { _, _, elapsed, _ in try await probe.finish(elapsed) }, receive: { source, _ in await probe.receive(source) })
        }
        defer { task.cancel() }
        let deadline = ContinuousClock.now + .seconds(2)
        while await probe.counts().downloads < swaps, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(2)) }
        let open = await probe.counts()
        XCTAssertEqual(open.downloads, swaps, "Every SWAP must hold its file concurrently without an EMFILE failure.")
        await probe.releaseDownloads(); await probe.releaseImports(); await probe.releaseFinishes()
        try await task.value
        let finished = await probe.counts(); XCTAssertEqual(finished.completed, swaps)
    }
}
