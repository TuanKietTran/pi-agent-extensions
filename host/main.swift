// Native Touch Bar quota charts. Uses private macOS Touch Bar presentation APIs.
import AppKit
import ObjectiveC

private let itemIdentifier = NSTouchBarItem.Identifier("dev.handlerone.usagebar.item")
private let chartIdentifier = NSTouchBarItem.Identifier("dev.handlerone.usagebar.charts")
private let dfr = dlopen("/System/Library/PrivateFrameworks/DFRFoundation.framework/DFRFoundation", RTLD_NOW)
private typealias PresenceFn = @convention(c) (NSString, ObjCBool) -> Void
private typealias BoolFn = @convention(c) (ObjCBool) -> Void

private func symbol<T>(_ name: String, as type: T.Type) -> T? {
    guard let dfr, let address = dlsym(dfr, name) else { return nil }
    return unsafeBitCast(address, to: type)
}

private struct Quota {
    let label: String
    let percent: Double?
    let stale: Bool
}

private enum UsageReader {
    static func read(force: Bool) -> [Quota]? {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/sh")
        let script = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".pi/agent/extensions/touchbar-usage/bin/pi-usagebar").path
        task.arguments = [script, "--json"] + (force ? ["--force"] : [])
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        do { try task.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        guard task.terminationStatus == 0,
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        var quotas: [Quota] = []
        for (key, label) in [("claude", "CC"), ("codex", "CX")] {
            guard let side = root[key] as? [String: Any] else {
                quotas.append(Quota(label: label, percent: nil, stale: true))
                continue
            }
            let age = Date().timeIntervalSince1970 - ((side["at"] as? Double) ?? 0) / 1000
            let stale = (side["ok"] as? Bool) != true || age > 900
            let windows = side["windows"] as? [[String: Any]] ?? []
            if windows.isEmpty {
                quotas.append(Quota(label: label, percent: nil, stale: true))
            }
            for window in windows {
                quotas.append(Quota(label: "\(label) \((window["label"] as? String) ?? "?")",
                                    percent: window["percent"] as? Double, stale: stale))
            }
        }
        return quotas
    }
}

// Fixed-width, left-aligned cards with a visible track even at zero usage.
private final class QuotaChart: NSView {
    var quotas: [Quota] = [] { didSet { needsDisplay = true } }
    override var intrinsicContentSize: NSSize { NSSize(width: 480, height: 30) }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.setFill()
        bounds.fill()
        let visible = Array(quotas.prefix(4))
        guard !visible.isEmpty else {
            drawText("Usage loading…", at: NSPoint(x: 8, y: 9), color: .secondaryLabelColor)
            return
        }
        let width = min(154, (bounds.width - 8) / CGFloat(visible.count))
        for (index, quota) in visible.enumerated() {
            let x = 6 + CGFloat(index) * width
            let value = quota.percent.map { "\(Int($0.rounded()))%" } ?? "—"
            let color: NSColor = quota.stale ? .systemOrange :
                ((quota.percent ?? 0) >= 90 ? .systemRed : .systemGreen)
            drawText("\(quota.label)  \(value)\(quota.stale ? " !" : "")",
                     at: NSPoint(x: x, y: 14), color: quota.stale ? .systemOrange : .white)
            let track = NSRect(x: x, y: 4, width: width - 14, height: 5)
            NSColor.darkGray.setFill()
            NSBezierPath(roundedRect: track, xRadius: 2.5, yRadius: 2.5).fill()
            if let percent = quota.percent, percent.isFinite, percent > 0 {
                let fill = NSRect(x: track.minX, y: track.minY,
                                  width: track.width * min(100, max(0, percent)) / 100,
                                  height: track.height)
                color.setFill()
                NSBezierPath(roundedRect: fill, xRadius: 2.5, yRadius: 2.5).fill()
            }
        }
    }
    private func drawText(_ text: String, at point: NSPoint, color: NSColor) {
        (text as NSString).draw(at: point, withAttributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium),
            .foregroundColor: color,
        ])
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSTouchBarDelegate {
    private let chart = QuotaChart()
    private var usageBar: NSTouchBar?
    private var trayItem: NSCustomTouchBarItem?
    private var timer: Timer?
    private var refreshing = false
    private var presentationWork: DispatchWorkItem?
    private var presentationRetry: DispatchWorkItem?
    private var contextTimer: Timer?
    private var windowContext = ""

    func applicationDidFinishLaunching(_ notification: Notification) {
        let tray = NSCustomTouchBarItem(identifier: itemIdentifier)
        tray.view = NSButton(title: "Usage", target: self, action: #selector(showCharts))
        trayItem = tray
        let cls = NSTouchBarItem.self as AnyObject
        let add = NSSelectorFromString("addSystemTrayItem:")
        guard cls.responds(to: add) else { fail("addSystemTrayItem unavailable"); return }
        _ = cls.perform(add, with: tray)
        let bar = NSTouchBar()
        bar.delegate = self
        bar.defaultItemIdentifiers = [chartIdentifier, .flexibleSpace]
        usageBar = bar
        // Let the tray registration reach TouchBarServer before presenting.
        symbol("DFRElementSetControlStripPresenceForIdentifier", as: PresenceFn.self)?(
            itemIdentifier.rawValue as NSString, true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            self?.showCharts()
        }
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            self?.refresh(force: false)
        }
        // Window IDs and owner PIDs require no Accessibility permission or titles.
        contextTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.checkWindowContext()
        }
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.showCharts()
            self?.refresh(force: true)
        }
        // Foreground applications replace the app-controls region on activation.
        // Re-present after their own Touch Bar has settled.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] notification in
            let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            guard application?.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return }
            self?.schedulePresentation()
        }
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.schedulePresentation() }
        refresh(force: false)
    }

    private func checkWindowContext() {
        guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier,
              pid != ProcessInfo.processInfo.processIdentifier else { return }
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let front = windows.first {
            ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) &&
            ($0[kCGWindowLayer as String] as? Int) == 0
        }
        let context = "\(pid):\((front?[kCGWindowNumber as String] as? Int) ?? 0)"
        guard context != windowContext else { return }
        windowContext = context
        schedulePresentation()
    }

    private func schedulePresentation() {
        presentationWork?.cancel()
        presentationRetry?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.restoreCharts()
            self?.refresh(force: false)
        }
        // Some apps install controls asynchronously after activation.
        let retry = DispatchWorkItem { [weak self] in self?.restoreCharts() }
        presentationWork = work
        presentationRetry = retry
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: retry)
    }

    private func restoreCharts() {
        guard let usageBar else { return }
        let cls = NSTouchBar.self as AnyObject
        let dismiss = NSSelectorFromString("dismissSystemModalTouchBar:")
        if cls.responds(to: dismiss) { _ = cls.perform(dismiss, with: usageBar) }
        showCharts()
    }

    func touchBar(_ touchBar: NSTouchBar, makeItemForIdentifier identifier: NSTouchBarItem.Identifier) -> NSTouchBarItem? {
        guard identifier == chartIdentifier else { return nil }
        let item = NSCustomTouchBarItem(identifier: identifier)
        item.view = chart
        return item
    }

    @objc private func showCharts() {
        guard let usageBar else { return }
        let present = NSSelectorFromString("presentSystemModalTouchBar:placement:systemTrayItemIdentifier:")
        guard let method = class_getClassMethod(NSTouchBar.self, present) else {
            fail("left-side Touch Bar presentation unavailable")
            return
        }
        symbol("DFRSystemModalShowsCloseBoxWhenFrontMost", as: BoolFn.self)?(false)
        symbol("DFRElementSetControlStripPresenceForIdentifier", as: PresenceFn.self)?(
            itemIdentifier.rawValue as NSString, true)
        typealias PresentFn = @convention(c) (AnyObject, Selector, NSTouchBar, Int, NSString) -> Void
        let invoke = unsafeBitCast(method_getImplementation(method), to: PresentFn.self)
        invoke(NSTouchBar.self, present, usageBar, 1, itemIdentifier.rawValue as NSString)
        // No per-activation logging: this is a persistent, frequently presented UI.
    }

    private func refresh(force: Bool) {
        guard !refreshing else { return }
        refreshing = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let next = UsageReader.read(force: force)
            DispatchQueue.main.async {
                self?.refreshing = false
                if let next { self?.chart.quotas = next }
            }
        }
    }
    private func fail(_ message: String) {
        FileHandle.standardError.write(Data("usagebar: \(message)\n".utf8))
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
