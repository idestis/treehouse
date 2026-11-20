// Place full-bleed artwork on Apple's macOS icon grid: an 824/1024 rounded
// square centred on a transparent canvas, with the standard soft shadow.
// usage: swift scripts/pad-icon.swift <src.png> <out.png> <size> [mark scale]
// The mark scale (default 1) shrinks the artwork inside the tile, filling
// the margin with the artwork's corner (its solid background).
import AppKit

let a = CommandLine.arguments
let src = NSImage(contentsOfFile: a[1])!
let size = CGFloat(Double(a[3])!)
let k = size / 1024
let inner = 824 * k
let origin = (size - inner) / 2
let rect = CGRect(x: origin, y: origin, width: inner, height: inner)
let radius = inner * 0.2237
let scale = a.count > 4 ? CGFloat(Double(a[4]) ?? 1) : 1
let markSide = inner * scale
let markRect = CGRect(x: origin + (inner - markSide) / 2, y: origin + (inner - markSide) / 2, width: markSide, height: markSide)

let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size),
  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let ctx = NSGraphicsContext.current!.cgContext
ctx.interpolationQuality = .high
let path = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
// Shadow (Apple template: ~28px blur, 12px down, 30% black at 1024).
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -12 * k), blur: 28 * k, color: NSColor.black.withAlphaComponent(0.3).cgColor)
ctx.addPath(path); ctx.setFillColor(NSColor.black.cgColor); ctx.fillPath()
ctx.restoreGState()
ctx.addPath(path); ctx.clip()
// Fill with a stretched corner patch of the artwork rather than a sampled colour:
// both then go through the same colour conversion, so the margin can't show a seam.
src.draw(in: rect, from: CGRect(x: 0, y: 0, width: 8, height: 8), operation: .copy, fraction: 1)
src.draw(in: markRect, from: .zero, operation: .copy, fraction: 1)
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[2]))
