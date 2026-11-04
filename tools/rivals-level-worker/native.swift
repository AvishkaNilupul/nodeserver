import Cocoa
import ApplicationServices
import Vision
import ImageIO
import CoreML

// Newline-delimited JSON. No account credentials are accepted by this driver.
struct DriverError: Error { let message: String }
func fail(_ message: String) throws -> Never { throw DriverError(message: message) }
func emit(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!); fflush(stdout)
}
func windows() -> [[String: Any]] {
    let entries = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    var result: [[String:Any]] = entries.filter { ($0[kCGWindowLayer as String] as? Int) == 0 }.compactMap { e in
        guard let p = e[kCGWindowOwnerPID as String] as? Int,
              let id = e[kCGWindowNumber as String] as? Int,
              let b = e[kCGWindowBounds as String] as? [String: Any] else { return nil }
        return ["pid": p, "id": id, "title": e[kCGWindowName as String] as? String ?? "",
                "owner": e[kCGWindowOwnerName as String] as? String ?? "", "bounds": b,
                "onscreen":e[kCGWindowIsOnscreen as String] as? Bool ?? false]
    }
    // Wine's exclusive Metal fullscreen surface is absent from the CG list.
    // Query only the game owners already discovered above, using bounded AX calls.
    let gamePids=Set(result.filter{($0["owner"] as? String ?? "").localizedCaseInsensitiveContains("marvel")}.compactMap{$0["pid"] as? Int})
    for pid in gamePids {
        let app=AXUIElementCreateApplication(Int32(pid));AXUIElementSetMessagingTimeout(app,0.25)
        var list:CFTypeRef?
        guard AXUIElementCopyAttributeValue(app,kAXWindowsAttribute as CFString,&list) == .success,let ws=list as? [AXUIElement] else {continue}
        for w in ws {
            AXUIElementSetMessagingTimeout(w,0.25)
            var title:CFTypeRef?,position:CFTypeRef?,size:CFTypeRef?
            AXUIElementCopyAttributeValue(w,kAXTitleAttribute as CFString,&title)
            guard let name=title as? String,!name.isEmpty,!result.contains(where:{($0["pid"] as? Int)==pid&&($0["title"] as? String)==name}) else {continue}
            AXUIElementCopyAttributeValue(w,kAXPositionAttribute as CFString,&position)
            AXUIElementCopyAttributeValue(w,kAXSizeAttribute as CFString,&size)
            guard let pv=position,let sv=size,CFGetTypeID(pv)==AXValueGetTypeID(),CFGetTypeID(sv)==AXValueGetTypeID() else {continue}
            var p=CGPoint.zero,s=CGSize.zero
            AXValueGetValue(pv as! AXValue,.cgPoint,&p);AXValueGetValue(sv as! AXValue,.cgSize,&s)
            if s.width>100&&s.height>100 {result.append(["pid":pid,"id":0,"title":name,"owner":"Marvel Rivals","source":"AX",
                "bounds":["X":p.x,"Y":p.y,"Width":s.width,"Height":s.height]])}
        }
    }
    return result
}
func target(_ request: [String: Any]) throws -> (Int32, [String: Any], CGRect) {
    guard let pid = request["pid"] as? Int, pid > 0, let title = request["title"] as? String,
          !title.isEmpty, let w = windows().first(where: { ($0["pid"] as? Int) == pid && ($0["title"] as? String) == title }),
          let b = w["bounds"] as? [String: Any], let rect = CGRect(dictionaryRepresentation: b as CFDictionary),
          rect.width > 100, rect.height > 100 else { try fail("Exact game window missing") }
    return (Int32(pid), w, rect)
}
let keycodes: [String: CGKeyCode] = ["w":13,"a":0,"s":1,"d":2,"e":14,"q":12,"r":15,"f":3,"v":9,
    "shift":56,"space":49,"escape":53,"return":36,"tab":48,"1":18,"2":19,"3":20,"4":21,"h":4,"b":11]
var heldKeys = Set<CGKeyCode>()
var heldMouse = false
func key(_ code: CGKeyCode, _ down: Bool) {
    let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)!
    e.flags = []; e.post(tap: .cghidEventTap)
    if down { heldKeys.insert(code) } else { heldKeys.remove(code) }
}
func mouse(_ type: CGEventType, _ point: CGPoint) {
    let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)!
    e.flags = []; e.setIntegerValueField(.mouseEventClickState, value: 1); e.post(tap: .cghidEventTap)
}
func release() {
    for k in heldKeys { key(k, false) }
    if heldMouse { mouse(.leftMouseUp, CGEvent(source: nil)!.location); heldMouse = false }
}
func releaseAll() {
    for k in keycodes.values { key(k, false) }
    mouse(.leftMouseUp, CGEvent(source: nil)!.location); heldMouse=false
}
func focused(_ pid: Int32) -> Bool { NSWorkspace.shared.frontmostApplication?.processIdentifier == pid }
func check(_ pid: Int32, _ stop: String?) throws {
    guard focused(pid) else { try fail("Game lost focus; all controls released") }
    if let stop = stop, FileManager.default.fileExists(atPath: stop) { try fail("STOP file present") }
    let p = CGEvent(source: nil)!.location
    if p.x < 3 && p.y < 3 { try fail("Emergency mouse corner reached") }
}
func capture(_ request: [String: Any]) throws -> [String: Any] {
    let (_, window, bounds) = try target(request)
    guard let output = request["output"] as? String, output.hasPrefix("/"), output.hasSuffix(".png") else { try fail("Absolute private PNG path required") }
    let temporary = output + ".display.png"
    let capturedAt=ISO8601DateFormatter().string(from:Date())
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    p.arguments = ["-x", temporary]; try p.run(); p.waitUntilExit()
    defer { try? FileManager.default.removeItem(atPath: temporary) }
    guard p.terminationStatus == 0,
          let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: temporary) as CFURL, nil),
          let full = CGImageSourceCreateImageAtIndex(source, 0, nil) else { try fail("Display capture failed") }
    let display = CGDisplayBounds(CGMainDisplayID())
    guard display.contains(bounds) else { try fail("Game must be entirely on the main display") }
    let sx = Double(full.width) / display.width, sy = Double(full.height) / display.height
    let cropRect = CGRect(x: (bounds.minX-display.minX)*sx, y: (bounds.minY-display.minY)*sy, width: bounds.width*sx, height: bounds.height*sy)
    guard let image = full.cropping(to: cropRect), let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: output) as CFURL, "public.png" as CFString, 1, nil) else { try fail("Game crop failed") }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { try fail("PNG write failed") }
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output)
    return try analyze(image, output:output).merging(["window":window,
            "frontmostPid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
            "capturedAt":capturedAt]) { _,new in new }
}
func analyze(_ image: CGImage, output: String) throws -> [String:Any] {
    let ocr = VNRecognizeTextRequest(); ocr.recognitionLevel = .accurate
    // Keep text inference off the game's GPU and avoid first-use ANE compilation.
    if #available(macOS 14.0, *) {
        guard let cpu=MLComputeDevice.allComputeDevices.first(where:{if case .cpu = $0 {return true};return false}) else {try fail("CPU text inference unavailable")}
        // Select the device before the first inference initializes its model.
        ocr.setComputeDevice(cpu,for:.main)
        ocr.setComputeDevice(cpu,for:.postProcessing)
    } else {ocr.usesCPUOnly=true}
    ocr.recognitionLanguages = ["en-US"]; ocr.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([ocr])
    let lines: [[String: Any]] = (ocr.results ?? []).compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let b = observation.boundingBox
        return ["text": candidate.string, "confidence": candidate.confidence,
                "x": b.minX, "y": 1-b.maxY, "width": b.width, "height": b.height]
    }
    return ["width":image.width, "height":image.height, "lines":lines, "output":output]
}
func perform(_ request: [String: Any]) throws -> [String: Any] {
    let command = request["command"] as? String ?? ""
    if command == "windows" { return ["windows":windows(),"trusted":AXIsProcessTrusted()] }
    if command == "analyze" {
        guard let file=request["file"] as? String, file.hasPrefix("/"),
              let source=CGImageSourceCreateWithURL(URL(fileURLWithPath:file) as CFURL,nil),
              let image=CGImageSourceCreateImageAtIndex(source,0,nil) else {try fail("PNG file unavailable")}
        return try analyze(image,output:file)
    }
    if command == "capture" { return try capture(request) }
    if command == "release" { release(); return ["released":true] }
    if command == "release-all" { releaseAll(); return ["released":true] }
    let (pid, _, bounds) = try target(request)
    guard AXIsProcessTrusted() else { try fail("Accessibility permission missing") }
    if command == "focus" {
        if let stop=request["stopFile"] as? String,FileManager.default.fileExists(atPath:stop){try fail("STOP file present")}
        let app = AXUIElementCreateApplication(pid); AXUIElementSetMessagingTimeout(app, 1)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
              let ws = value as? [AXUIElement] else { try fail("Window accessibility unavailable") }
        let title = request["title"] as! String
        guard let w = ws.first(where: { element in
            var n: CFTypeRef?; AXUIElementCopyAttributeValue(element,kAXTitleAttribute as CFString,&n)
            return (n as? String) == title
        }) else { try fail("Exact accessible game window missing") }
        AXUIElementPerformAction(w, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        usleep(200000)
        guard focused(pid) else { try fail("Could not focus game") }
        return ["focused":true]
    }
    let stop = request["stopFile"] as? String
    try check(pid, stop)
    guard let expected=request["expectedBounds"] as? [String:Any],
          let previous=CGRect(dictionaryRepresentation:expected as CFDictionary),
          abs(previous.minX-bounds.minX)<2,abs(previous.minY-bounds.minY)<2,
          abs(previous.width-bounds.width)<2,abs(previous.height-bounds.height)<2 else {try fail("Game bounds changed since the observed frame")}
    if command == "click" {
        guard let x = request["x"] as? Double, let y = request["y"] as? Double,
              x >= 0, x <= 1, y >= 0, y <= 1 else { try fail("Normalized visible coordinates required") }
        let p = CGPoint(x:bounds.minX+x*bounds.width,y:bounds.minY+y*bounds.height)
        mouse(.mouseMoved,p); usleep(70000); mouse(.leftMouseDown,p); heldMouse=true
        usleep(90000); mouse(.leftMouseUp,p); heldMouse=false
        return ["clicked":true]
    }
    if command == "controls" {
        let names = request["keys"] as? [String] ?? []
        guard names.count <= 4, names.allSatisfy({keycodes[$0] != nil}),
              let ms = request["milliseconds"] as? Int, ms >= 20, ms <= 3000 else { try fail("Bounded known controls required") }
        let dx = request["dx"] as? Int ?? 0, dy = request["dy"] as? Int ?? 0
        guard abs(dx) <= 400, abs(dy) <= 250 else { try fail("Mouse movement exceeds one-frame bound") }
        if dx != 0 || dy != 0 {
            let point = CGPoint(x:bounds.midX,y:bounds.midY)
            let e = CGEvent(mouseEventSource:nil,mouseType:.mouseMoved,mouseCursorPosition:point,mouseButton:.left)!
            e.setIntegerValueField(.mouseEventDeltaX,value:Int64(dx)); e.setIntegerValueField(.mouseEventDeltaY,value:Int64(dy));e.post(tap:.cghidEventTap)
        }
        for name in names { key(keycodes[name]!,true) }
        if request["fire"] as? Bool == true { mouse(.leftMouseDown,CGEvent(source:nil)!.location);heldMouse=true }
        defer { release() }
        for _ in 0..<max(1,ms/25) { try check(pid,stop);usleep(25000) }
        return ["controlledMs":ms]
    }
    try fail("Unknown native command")
}
while let line = readLine() {
    do {
        guard line.utf8.count <= 16384, let data = line.data(using:.utf8),
              let request = try JSONSerialization.jsonObject(with:data) as? [String:Any] else { try fail("Invalid request") }
        emit(["ok":true,"result":try perform(request)])
    } catch {
        release(); emit(["ok":false,"error":(error as? DriverError)?.message ?? "Native operation failed"])
    }
}
release()
