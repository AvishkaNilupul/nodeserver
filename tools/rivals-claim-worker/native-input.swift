import Cocoa
import ApplicationServices
let args = CommandLine.arguments
guard (args.count == 5 || args.count == 6), ["click", "click-current", "keys", "text"].contains(args[2]), let pid = Int32(args[1]), let x = Double(args[3]), let y = Double(args[4]), AXIsProcessTrusted() else { exit(2) }
func event(_ type:CGEventType,_ point:CGPoint)->CGEvent {
 let e=CGEvent(mouseEventSource:nil,mouseType:type,mouseCursorPosition:point,mouseButton:.left)!
 e.flags=[];e.setIntegerValueField(.mouseEventClickState,value:1);return e
}
let app = AXUIElementCreateApplication(pid)
var windows: CFTypeRef?
guard AXUIElementCopyAttributeValue(app,kAXWindowsAttribute as CFString,&windows) == .success, let ws = windows as? [AXUIElement], !ws.isEmpty else { exit(3) }
guard let target=ws.first(where: { w in
 var name:CFTypeRef?
 AXUIElementCopyAttributeValue(w,kAXTitleAttribute as CFString,&name)
 return (name as? String) == (args.count == 6 ? args[5] : "Steam")
}) else { exit(6) }
if args[2] != "click-current" {
 AXUIElementPerformAction(target,kAXRaiseAction as CFString)
 AXUIElementSetAttributeValue(app,kAXFrontmostAttribute as CFString,kCFBooleanTrue)
}
usleep(400000)
guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { exit(4) }
let pt=CGPoint(x:x,y:y)
event(.mouseMoved,pt).post(tap:.cghidEventTap)
usleep(200000)
event(.leftMouseDown,pt).post(tap:.cghidEventTap)
usleep(120000)
event(.leftMouseUp,pt).post(tap:.cghidEventTap)
if args[2] == "keys" {
 let value=String(data:FileHandle.standardInput.readDataToEndOfFile(),encoding:.utf8) ?? ""
 guard value.utf16.count <= 256, value.utf8.allSatisfy({ $0 < 128 }) else { exit(5) }
 let plain: [Character:CGKeyCode] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"=":24,"9":25,"7":26,"-":27,"8":28,"0":29,"]":30,"o":31,"u":32,"[":33,"i":34,"p":35,"l":37,"j":38,"\'":39,"k":40,";":41,"\\":42,",":43,"/":44,"n":45,"m":46,".":47,"`":50," ":49]
 let shifted=Array("!@#$%^&*()_+{}|:\"<>?~")
 let bases=Array("1234567890-=[]\\;\',./`")
 var keys:[(CGKeyCode,CGEventFlags)]=[]
 for ch in value {
  let lower=Character(String(ch).lowercased())
  if let code=plain[lower] {keys.append((code,ch != lower ? .maskShift : []))}
  else if let i=shifted.firstIndex(of:ch),i < bases.count,let code=plain[bases[i]] {keys.append((code,.maskShift))}
  else {exit(7)}
 }
 func key(_ code:CGKeyCode,_ flags:CGEventFlags) {
  let down=CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:true)!;down.flags=flags;down.post(tap:.cghidEventTap)
  usleep(30000)
  let up=CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:false)!;up.flags=flags;up.post(tap:.cghidEventTap)
  usleep(30000)
 }
 key(0,.maskControl);usleep(200000)
 for (code,flags) in keys {key(code,flags)}
} else if args[2] == "text" {
 usleep(150000)
 let value=String(data:FileHandle.standardInput.readDataToEndOfFile(),encoding:.utf8) ?? ""
 guard value.utf16.count <= 256 else { exit(5) }
 let pb=NSPasteboard.general
 let old=pb.pasteboardItems?.map { item -> NSPasteboardItem in
  let saved=NSPasteboardItem()
  for t in item.types { if let d=item.data(forType:t){saved.setData(d,forType:t)} }
  return saved
 } ?? []
 let selectDown=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:true)!
 selectDown.flags = .maskControl;selectDown.post(tap:.cghidEventTap)
 usleep(100000)
 let selectUp=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:false)!
 selectUp.flags = .maskControl;selectUp.post(tap:.cghidEventTap)
 pb.clearContents();pb.setString(value,forType:.string)
 usleep(1500000)
 let down=CGEvent(keyboardEventSource:nil,virtualKey:9,keyDown:true)!
 down.flags = .maskControl; down.post(tap:.cghidEventTap)
 usleep(120000)
 let up=CGEvent(keyboardEventSource:nil,virtualKey:9,keyDown:false)!
 up.flags = .maskControl;up.post(tap:.cghidEventTap)
 usleep(1500000)
 pb.clearContents();if !old.isEmpty {pb.writeObjects(old)}
}
