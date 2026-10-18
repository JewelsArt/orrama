import AppKit
// usage: render <mark.svg> <out.png> <size> <style: mac|full>
let a = CommandLine.arguments
let svg = NSImage(contentsOf: URL(fileURLWithPath: a[1]))!
let S = CGFloat(Double(a[3])!), mac = a[4] == "mac"
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(S), pixelsHigh: Int(S), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let paper = NSColor(srgbRed: 0xF9/255, green: 0xF7/255, blue: 0xF3/255, alpha: 1)
var body = NSRect(x: 0, y: 0, width: S, height: S)
if mac {
  // Apple's macOS grid: an 824/1024 rounded square, radius ~185/1024, a soft shadow under it.
  let k = S / 1024; body = NSRect(x: 100*k, y: 100*k, width: 824*k, height: 824*k)
  let path = NSBezierPath(roundedRect: body, xRadius: 185.4*k, yRadius: 185.4*k)
  NSGraphicsContext.saveGraphicsState()
  let sh = NSShadow(); sh.shadowColor = NSColor(white: 0, alpha: 0.28); sh.shadowBlurRadius = 18*k; sh.shadowOffset = NSSize(width: 0, height: -6*k); sh.set()
  paper.setFill(); path.fill()
  NSGraphicsContext.restoreGraphicsState()
  NSColor(white: 0, alpha: 0.06).setStroke(); path.lineWidth = 1*k; path.stroke()
} else { paper.setFill(); body.fill() }
// The figure: 60% of the body's height, centred, nudged up a little so it sits optically centred.
let ar = svg.size.width / svg.size.height
let h = body.height * 0.60, w = h * ar
let r = NSRect(x: body.midX - w/2, y: body.midY - h/2 + body.height*0.01, width: w, height: h)
svg.draw(in: r, from: .zero, operation: .sourceOver, fraction: 1)
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[2]))
