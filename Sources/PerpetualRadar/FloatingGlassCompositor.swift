import AppKit

/// Backdrop filters in a transparent WKWebView source-over their blurred alpha
/// onto the original text. Filter the actual layers behind floating surfaces so
/// each pixel is drawn once. CSS still owns every radius, shape, and color.
@MainActor
final class FloatingGlassCompositor {
    private struct Surface {
        let rect: CGRect
        let radius: CGFloat
        let corner: CGFloat
    }
    private struct Applied {
        let layer: CALayer
        let signature: [CGFloat]
    }
    private weak var view: NSView?
    private var surfaces: [Surface] = []
    private var observations: [ObjectIdentifier: [NSKeyValueObservation]] = [:]
    private var applied: [ObjectIdentifier: Applied] = [:]
    private var hidden: [ObjectIdentifier: (CALayer, Bool)] = [:]
    private var scheduled = false
    private var updating = false
    private static let filterName = "perpetual.floating.sourceBlur"
    private static let backdropClass: AnyClass? = NSClassFromString("CABackdropLayer")
    private static let filterClass = NSClassFromString("CAFilter") as? NSObject.Type

    init(view: NSView) { self.view = view }

    func update(_ values: [[String: Double]]) {
        surfaces = values.compactMap { value in
            guard let x = value["x"], let y = value["y"], let width = value["width"], let height = value["height"],
                  let radius = value["radius"], let corner = value["corner"],
                  [x, y, width, height, radius, corner].allSatisfy(\.isFinite), width > 0, height > 0, radius > 0 else { return nil }
            return Surface(rect: CGRect(x: x, y: y, width: width, height: height), radius: radius, corner: max(0, corner))
        }
        if surfaces.isEmpty { reset() } else { schedule() }
    }

    func reset() {
        observations.removeAll()
        for entry in applied.values { removeFilter(from: entry.layer) }
        for (layer, wasHidden) in hidden.values { layer.isHidden = wasHidden }
        applied.removeAll(); hidden.removeAll(); surfaces.removeAll()
    }

    private func schedule() {
        guard !scheduled, !updating, !surfaces.isEmpty else { return }
        scheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.scheduled = false
            self.refresh()
        }
    }

    private func observe(_ layer: CALayer) {
        let id = ObjectIdentifier(layer)
        guard observations[id] == nil else { return }
        // WebKit also updates scrolling layers off the main thread. KVO runs
        // on the mutating thread, so enqueue before touching compositor state.
        // schedule() coalesces notifications without blocking WebKit's locks.
        let changed: @Sendable () -> Void = { [weak self] in
            DispatchQueue.main.async { [weak self] in self?.schedule() }
        }
        observations[id] = [
            layer.observe(\.sublayers) { _, _ in changed() },
            layer.observe(\.bounds) { _, _ in changed() },
            layer.observe(\.position) { _, _ in changed() },
            layer.observe(\.transform) { _, _ in changed() },
            layer.observe(\.sublayerTransform) { _, _ in changed() },
            layer.observe(\.filters) { _, _ in changed() },
            layer.observe(\.isHidden) { _, _ in changed() },
        ]
    }

    private func refresh() {
        guard !surfaces.isEmpty, let root = view?.layer, let backdropClass = Self.backdropClass else { return }
        updating = true
        defer { updating = false }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        var layers: [CALayer] = []
        func collect(_ layer: CALayer) {
            layers.append(layer); observe(layer)
            for child in layer.sublayers ?? [] { collect(child) }
        }
        collect(root)
        let live = Set(layers.map(ObjectIdentifier.init))
        observations = observations.filter { live.contains($0.key) }
        var sources: [ObjectIdentifier: (CALayer, [Surface])] = [:]
        var targets = Set<ObjectIdentifier>()
        for backdrop in layers where backdrop.isKind(of: backdropClass) && !(backdrop.filters ?? []).isEmpty {
            let rect = root.convert(backdrop.bounds, from: backdrop)
            guard let surface = surfaces.first(where: {
                abs($0.rect.minX - rect.minX) < 2 && abs($0.rect.minY - rect.minY) < 2 &&
                abs($0.rect.width - rect.width) < 2 && abs($0.rect.height - rect.height) < 2
            }) else { continue }
            let id = ObjectIdentifier(backdrop)
            targets.insert(id)
            if hidden[id] == nil { hidden[id] = (backdrop, backdrop.isHidden) }
            // Notifications are asynchronous, including our own mutations.
            // Avoid generating another notification on an unchanged backdrop.
            if !backdrop.isHidden { backdrop.isHidden = true }

            func addSource(_ source: CALayer) {
                guard !source.isHidden, source.opacity > 0 else { return }
                if source.bounds.isEmpty {
                    for child in source.sublayers ?? [] { addSource(child) }
                    return
                }
                let local = source.convert(surface.rect, from: root)
                guard source.bounds.intersects(local) else { return }
                let scale = local.width / surface.rect.width
                let localSurface = Surface(rect: local, radius: surface.radius * scale, corner: surface.corner * scale)
                let sourceID = ObjectIdentifier(source)
                if sources[sourceID] == nil { sources[sourceID] = (source, []) }
                sources[sourceID]!.1.append(localSurface)
            }
            // Portals are siblings in paint order. Never filter an ancestor
            // containing the popup's own foreground or a later floating layer.
            var branch = backdrop
            while branch !== root, let parent = branch.superlayer {
                for sibling in parent.sublayers ?? [] {
                    if sibling === branch { break }
                    addSource(sibling)
                }
                branch = parent
            }
        }
        for (id, entry) in applied where sources[id] == nil {
            removeFilter(from: entry.layer); applied.removeValue(forKey: id)
        }
        for (id, (layer, wasHidden)) in hidden where !targets.contains(id) {
            layer.isHidden = wasHidden; hidden.removeValue(forKey: id)
        }
        for (id, (layer, regions)) in sources {
            let signature = [layer.bounds.minX, layer.bounds.minY, layer.bounds.width, layer.bounds.height] + regions.flatMap {
                [$0.rect.minX, $0.rect.minY, $0.rect.width, $0.rect.height, $0.radius, $0.corner]
            }
            if applied[id]?.signature == signature, (layer.filters ?? []).contains(where: isOurFilter) { continue }
            // Keep WebKit's original effect if the native filter is unavailable;
            // never leave its backdrop hidden after an allocation/API failure.
            guard let filter = makeFilter(bounds: layer.bounds, regions: regions) else { reset(); return }
            layer.filters = (layer.filters ?? []).filter { !isOurFilter($0) } + [filter]
            applied[id] = Applied(layer: layer, signature: signature)
        }
    }

    private func isOurFilter(_ value: Any) -> Bool {
        guard let object = value as? NSObject, object.responds(to: NSSelectorFromString("name")) else { return false }
        return object.value(forKey: "name") as? String == Self.filterName
    }

    private func removeFilter(from layer: CALayer) {
        guard (layer.filters ?? []).contains(where: isOurFilter) else { return }
        let remaining = (layer.filters ?? []).filter { !isOurFilter($0) }
        layer.filters = remaining.isEmpty ? nil : remaining
    }

    private func makeFilter(bounds: CGRect, regions: [Surface]) -> NSObject? {
        let selector = NSSelectorFromString("filterWithType:")
        guard let factory = Self.filterClass, factory.responds(to: selector),
              let filter = factory.perform(selector, with: "variableBlur")?.takeUnretainedValue() as? NSObject else { return nil }
        // A bounded alpha mask avoids allocating a full Retina bitmap of long
        // virtualized tables. This is a sampling budget, not a material token.
        let scale = min(1, 4096 / max(bounds.width, bounds.height))
        let width = max(1, Int(ceil(bounds.width * scale))), height = max(1, Int(ceil(bounds.height * scale)))
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.scaleBy(x: CGFloat(width) / bounds.width, y: CGFloat(height) / bounds.height)
        context.translateBy(x: -bounds.minX, y: bounds.maxY)
        context.scaleBy(x: 1, y: -1)
        context.setBlendMode(.copy)
        let radius = regions.map(\.radius).max()!
        for region in regions.sorted(by: { $0.radius < $1.radius }) {
            context.setFillColor(gray: 1, alpha: region.radius / radius)
            context.addPath(CGPath(roundedRect: region.rect, cornerWidth: region.corner, cornerHeight: region.corner, transform: nil))
            context.fillPath()
        }
        guard let mask = context.makeImage() else { return nil }
        filter.setValue(Self.filterName, forKey: "name")
        filter.setValue(radius, forKey: "inputRadius")
        filter.setValue(mask, forKey: "inputMaskImage")
        filter.setValue(true, forKey: "inputNormalizeEdgesTransparent")
        return filter
    }
}
