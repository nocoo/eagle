import AppKit
import Foundation

/// Builds the two app marks from the Eagle brand composition:
///
/// * `Support/AppIcon.iconset` -> `Sources/EagleDesign/Resources/AppIcon.icns`, the released
///   bundle icon.
/// * `Support/AppIconDev.iconset` -> `Sources/EagleDesign/Resources/AppIconDev.icns`, the same
///   artwork with a red DEV ribbon across the top-right corner, for a bundle-less
///   `swift run "Eagle Dev"` (see `EagleIcon`).
///
/// Source artwork: hexly.ai `public/brands/eagle/v1.0.0/hero-square.webp`
/// (authored composition of the approved 2048 px eagle foreground plus its
/// mountain-birch texture). Copied here as PNG so the build needs no network
/// and no sibling checkout.
///
///     swift Scripts/make-icon.swift

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let texture = root.appendingPathComponent("Support/Brand/eagle-texture.png")
let mark = root.appendingPathComponent("Support/Brand/eagle-mark.png")
let iconset = root.appendingPathComponent("Support/AppIcon.iconset")
let devIconset = root.appendingPathComponent("Support/AppIconDev.iconset")
let output = root.appendingPathComponent("Sources/EagleDesign/Resources/AppIcon.icns")
let devOutput = root.appendingPathComponent("Sources/EagleDesign/Resources/AppIconDev.icns")

guard let textureImage = NSImage(contentsOf: texture), let markImage = NSImage(contentsOf: mark)
else {
  print("missing brand artwork under Support/Brand")
  exit(1)
}

/// Paper, mountain-birch leaves on the left, faceted eagle over them. The
/// texture is mirrored so the leaf cluster sits opposite the streamer instead of
/// underneath it.
func composition() -> NSImage {
  let canvas = NSImage(size: NSSize(width: 1024, height: 1024))
  canvas.lockFocus()
  NSColor(srgbRed: 0.969, green: 0.953, blue: 0.918, alpha: 1).setFill()
  NSRect(x: 0, y: 0, width: 1024, height: 1024).fill()

  NSGraphicsContext.saveGraphicsState()
  let flip = NSAffineTransform()
  flip.translateX(by: 1024, yBy: 0)
  flip.scaleX(by: -1, yBy: 1)
  flip.concat()
  textureImage.draw(
    in: NSRect(x: -60, y: -60, width: 1144, height: 1144),
    from: .zero,
    operation: .sourceOver,
    fraction: 0.92
  )
  NSGraphicsContext.restoreGraphicsState()

  // Oversized so the bust runs past the squircle body: the artwork has a hard
  // bottom edge that must stay outside the mask.
  let size: CGFloat = 1024
  let inset = (1024 - size) / 2
  markImage.draw(
    in: NSRect(x: inset + 14, y: -86, width: size, height: size),
    from: .zero,
    operation: .sourceOver,
    fraction: 1
  )
  canvas.unlockFocus()
  return canvas
}

let image = composition()

/// Apple's macOS icon grid: an 824 pt body centred in a 1024 pt canvas with a
/// 185 pt corner radius.
let canvas: CGFloat = 1024
let inset: CGFloat = 100
let radius: CGFloat = 185

/// The development mark: a red sash across the top-right corner, one fifth of the body wide,
/// with DEV set in white along the sash. Drawn inside the same rounded body, so the ribbon is
/// cut by the icon edge instead of hanging off it.
func drawDevRibbon(in body: NSRect) {
  let width = body.width * 0.20
  // The sash lies inside the corner and clears the rounded edge, so both ends are cut by the
  // straight top and right edges instead of spilling past the rounded corner. In y-up
  // coordinates it is the strip around x + y = k, one width measured perpendicular to that
  // line; the corner arc's centre is (body.max - radius) on both axes.
  let outer = body.maxX + body.maxY
  let k = outer - width / sqrt(2)
  let center = NSPoint(x: k / 2, y: k / 2)
  let transform = NSAffineTransform()
  transform.translateX(by: center.x, yBy: center.y)
  transform.rotate(byDegrees: -45)

  NSGraphicsContext.saveGraphicsState()
  transform.concat()
  NSColor(srgbRed: 0.878, green: 0.153, blue: 0.157, alpha: 1).setFill()
  NSRect(x: -body.width, y: -width / 2, width: body.width * 2, height: width).fill()
  NSGraphicsContext.restoreGraphicsState()

  NSGraphicsContext.saveGraphicsState()
  transform.concat()
  let font = NSFont.systemFont(ofSize: width * 0.40, weight: .bold)
  let text = NSAttributedString(
    string: "DEV",
    attributes: [
      .font: font,
      .foregroundColor: NSColor.white,
      .kern: width * 0.06,
    ])
  let size = text.size()
  // Worn along the sash, in the middle of what the corner actually shows: local +y points at
  // the corner, so the letters sit a little inward from the band's centre line.
  text.draw(
    at: NSPoint(
      x: -size.width / 2 + width * 0.08, y: -size.height / 2 - width * 0.27))
  NSGraphicsContext.restoreGraphicsState()
}

func render(_ size: CGFloat, development: Bool = false) -> Data? {
  let pixels = Int(size)
  guard
    let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil,
      pixelsWide: pixels,
      pixelsHigh: pixels,
      bitsPerSample: 8,
      samplesPerPixel: 4,
      hasAlpha: true,
      isPlanar: false,
      colorSpaceName: .deviceRGB,
      bytesPerRow: 0,
      bitsPerPixel: 0
    )
  else { return nil }
  rep.size = NSSize(width: size, height: size)

  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let scale = size / canvas
  let body = NSRect(
    x: inset * scale,
    y: inset * scale,
    width: (canvas - inset * 2) * scale,
    height: (canvas - inset * 2) * scale
  )
  let clip = NSBezierPath(
    roundedRect: body,
    xRadius: radius * scale,
    yRadius: radius * scale
  )
  clip.addClip()
  image.draw(in: body, from: .zero, operation: .sourceOver, fraction: 1)
  if development { drawDevRibbon(in: body) }

  // Hairline highlight so the edge stays crisp on light and dark desktops.
  NSColor.white.withAlphaComponent(0.20).setStroke()
  clip.lineWidth = max(1, scale)
  clip.stroke()

  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])
}

let variants: [(String, CGFloat)] = [
  ("icon_16x16", 16),
  ("icon_16x16@2x", 32),
  ("icon_32x32", 32),
  ("icon_32x32@2x", 64),
  ("icon_128x128", 128),
  ("icon_128x128@2x", 256),
  ("icon_256x256", 256),
  ("icon_256x256@2x", 512),
  ("icon_512x512", 512),
  ("icon_512x512@2x", 1024),
]

func write(directory: URL, output: URL, development: Bool) throws {
  try? FileManager.default.removeItem(at: directory)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  for (name, size) in variants {
    guard let data = render(size, development: development) else {
      print("failed to render \(name)")
      exit(1)
    }
    try data.write(to: directory.appendingPathComponent("\(name).png"))
  }

  let iconutil = Process()
  iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
  iconutil.arguments = ["-c", "icns", directory.path, "-o", output.path]
  try iconutil.run()
  iconutil.waitUntilExit()
  guard iconutil.terminationStatus == 0 else {
    print("iconutil failed")
    exit(1)
  }
  print("wrote \(output.path)")
}

try write(directory: iconset, output: output, development: false)
try write(directory: devIconset, output: devOutput, development: true)
