import AppKit
import WebKit
import ImageIO
import UniformTypeIdentifiers

@MainActor
func captureChartImage(in webView: WKWebView, bounds: [String: Any],
                       completion: @escaping @MainActor @Sendable (NSImage?, String?) -> Void) {
    guard let x = bounds["x"] as? Double, x.isFinite,
          let y = bounds["y"] as? Double, y.isFinite,
          let width = bounds["width"] as? Double, width.isFinite, width > 0,
          let height = bounds["height"] as? Double, height.isFinite, height > 0,
          let backgroundRGB = bounds["backgroundRGB"] as? [Double], backgroundRGB.count == 3,
          backgroundRGB.allSatisfy({ $0.isFinite && (0...1).contains($0) }) else {
        completion(nil, "Invalid chart bounds"); return
    }
    let rect = CGRect(x: x, y: y, width: width, height: height).intersection(webView.bounds)
    guard !rect.isNull, rect.width > 0, rect.height > 0 else { completion(nil, "Chart is outside the window"); return }
    let configuration = WKSnapshotConfiguration()
    configuration.rect = rect; configuration.afterScreenUpdates = true
    webView.takeSnapshot(with: configuration) { image, error in
        guard let image else { completion(nil, error?.localizedDescription ?? "Could not capture chart screenshot"); return }
        guard let opaque = opaqueChartSnapshot(image, backgroundRGB: backgroundRGB) else {
            completion(nil, "Could not prepare chart screenshot"); return
        }
        completion(opaque, nil)
    }
}

func chartSnapshotPNG(_ image: NSImage) -> [String: Any]? {
    guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
          let data = CFDataCreateMutable(nil, 0),
          let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(destination, cgImage, nil)
    guard CGImageDestinationFinalize(destination) else { return nil }
    let png = data as Data
    return ["imageDataURL": "data:image/png;base64," + png.base64EncodedString(),
            "width": cgImage.width, "height": cgImage.height]
}

func opaqueChartSnapshot(_ image: NSImage, backgroundRGB: [Double]) -> NSImage? {
    guard backgroundRGB.count == 3, backgroundRGB.allSatisfy({ $0.isFinite && (0...1).contains($0) }),
          let source = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
          let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let background = CGColor(colorSpace: colorSpace, components: backgroundRGB.map { CGFloat($0) } + [1]),
          let context = CGContext(data: nil, width: source.width, height: source.height,
                                  bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
    let rect = CGRect(x: 0, y: 0, width: source.width, height: source.height)
    context.setFillColor(background)
    context.fill(rect)
    context.draw(source, in: rect)
    guard let result = context.makeImage() else { return nil }
    return NSImage(cgImage: result, size: image.size)
}
