import AppKit

@MainActor
final class WindowMaterialView: NSVisualEffectView {
    init(content: NSView) {
        super.init(frame: .zero)
        material = .underWindowBackground
        blendingMode = .behindWindow
        state = .active
        wantsLayer = true
        addSubview(content)
        content.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: leadingAnchor),
            content.trailingAnchor.constraint(equalTo: trailingAnchor),
            content.topAnchor.constraint(equalTo: topAnchor),
            content.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }
}
