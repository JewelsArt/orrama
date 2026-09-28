// WebKit snapshot probe — what the desktop app (WKWebView) actually draws.
// Chrome and WebKit differ on CSP + blob: PDFs; see CLAUDE.md, "Check policy changes in WebKit".
// Build: swiftc -O scripts/webkit-snap.swift -o /tmp/webkit-snap
// Run:   /tmp/webkit-snap <url> <out.png>   (prints ink=<n>; 0 means nothing rendered)
import AppKit
import WebKit
let url = URL(string: CommandLine.arguments[1])!, out = CommandLine.arguments[2]
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let cfg = WKWebViewConfiguration(); cfg.websiteDataStore = .nonPersistent()
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 700, height: 500), configuration: cfg)
let win = NSWindow(contentRect: web.frame, styleMask: [.titled], backing: .buffered, defer: false)
win.contentView = web; win.orderFrontRegardless()
web.load(URLRequest(url: url))
DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
  web.takeSnapshot(with: nil) { img, _ in
    if let img, let t = img.tiffRepresentation, let r = NSBitmapImageRep(data: t), let p = r.representation(using: .png, properties: [:]) {
      try? p.write(to: URL(fileURLWithPath: out))
      // Crude "did anything render": count non-white pixels.
      var ink = 0
      for y in stride(from: 0, to: r.pixelsHigh, by: 4) { for x in stride(from: 0, to: r.pixelsWide, by: 4) {
        if let c = r.colorAt(x: x, y: y), c.brightnessComponent < 0.9 { ink += 1 } } }
      print("ink=\(ink)")
    }
    exit(0)
  }
}
app.run()
