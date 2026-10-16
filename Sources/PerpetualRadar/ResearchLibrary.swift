import Foundation

// Library reads must stay independent of both AppKit and the preparation/chart
// workers. A multi-million-row cache or a large frozen manifest must not block
// window events, workspace switches, progress delivery, or pause requests.
actor ResearchLibrary {
    private let directory: URL
    private var connection: ResearchStore?
    private var counts: (version: Int, files: Int, rows: Int)?

    init(directory: URL) { self.directory = directory }

    private func store() throws -> ResearchStore {
        if let connection { return connection }
        let opened = try ResearchStore(directory: directory)
        connection = opened
        return opened
    }

    // Transfer fresh JSON object graphs to the bridge, without decoding or
    // encoding the potentially multi-megabyte payload again on the main actor.
    private func snapshot<T: Encodable>(_ value: T) throws -> sending Any {
        try JSONSerialization.jsonObject(with: Data(researchJSON(value).utf8))
    }

    func plan(_ id: String) throws -> sending [String: Any] {
        guard let saved = try store().get(id, as: DataPlan.self) else { throw FilterError("Data plan not found.") }
        let plan = try saved.excludingSpread()
        return ["plan": try snapshot(plan), "estimatedBytes": plan.estimatedBytes]
    }

    func study(_ id: String) throws -> sending [String: Any] {
        let store = try store()
        guard let study = try store.get(id, as: ResearchStudy.self) else { throw FilterError("Study not found.") }
        let report = try store.get("report:\(id)", as: StudyReport.self)
        let manifest = try study.manifestID.flatMap { try store.get($0, as: DataManifest.self) }
        let savedPlan = try store.get(study.planID, as: DataPlan.self)
        let plan = try study.manifestID == nil ? savedPlan?.excludingSpread() : savedPlan
        return ["study": try snapshot(study), "report": try report.map(snapshot) ?? NSNull(),
                "manifest": try manifest.map(snapshot) ?? NSNull(), "plan": try plan.map(snapshot) ?? NSNull(),
                "estimatedBytes": plan?.estimatedBytes ?? 0]
    }

    func events(_ id: String, offset: Int) throws -> sending [String: Any] {
        let store = try store()
        return ["events": try snapshot(store.events(id, offset: offset)),
                "count": try store.count("SELECT COUNT(*) FROM research_events WHERE study=?", [id])]
    }

    func inventory() throws -> sending [String: Any] {
        let store = try store()
        // Inventory needs only display state, never the checkpoint's thousands
        // of completed source IDs, timings, or resumable calculation episodes.
        struct SavedStatus: Decodable { var phase: String; var error: String?; var updatedAt: Int64 }
        var studies: [[String: Any]] = []
        for study in try store.objects("study", as: ResearchStudy.self)
        where ["filter", "score", "comparison"].contains(study.spec.kind)
            && (study.spec.strategyPhase == nil || study.spec.strategyPhase == "bullishSetup") {
            var item = try snapshot(study) as! [String: Any]
            let checkpoint = try store.get("checkpoint:\(study.id)", as: SavedStatus.self)
            let phase = checkpoint?.phase ?? "paused"
            item["phase"] = ["running", "preparing", "planning"].contains(phase) ? "paused" : phase
            item["error"] = checkpoint?.error ?? ""
            item["active"] = false
            item["updatedAt"] = checkpoint?.updatedAt ?? study.createdAt
            studies.append(item)
        }
        // data_version is meaningful across polls on this retained connection.
        // Other connections' commits invalidate the in-memory totals, while an
        // idle prepared dataset no longer triggers a repeated full-table count.
        let version = try store.count("PRAGMA data_version")
        if counts?.version != version {
            counts = (version, try store.count("SELECT COUNT(*) FROM research_objects WHERE kind='source'"),
                      try store.count("SELECT COUNT(*) FROM research_heads"))
        }
        return ["studies": studies, "cacheDirectory": directory.path,
                "rawFiles": counts!.files, "cachedRows": counts!.rows]
    }
}
