import Foundation

// Failure modes: bundle identity changes; new contents retain quarantine;
// quarantine removal follows a symlink; invalid staging damages the live app;
// a failed fallback move does not restore the previous contents.
let fm = FileManager.default
let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let installer = URL(fileURLWithPath: CommandLine.arguments[2])
let resultPath = URL(fileURLWithPath: CommandLine.arguments[3])
let app = root.appendingPathComponent("Postal Snap's.app")
let stage = root.appendingPathComponent("staged")
let backup = root.appendingPathComponent("backup")
let outside = root.appendingPathComponent("outside")
for path in [app.appendingPathComponent("Contents"), stage.appendingPathComponent("Contents/nested")] {
    try fm.createDirectory(at: path, withIntermediateDirectories: true)
}
try "old".write(to: app.appendingPathComponent("Contents/version"), atomically: false, encoding: .utf8)
try "new".write(to: stage.appendingPathComponent("Contents/version"), atomically: false, encoding: .utf8)
try "nested".write(to: stage.appendingPathComponent("Contents/nested/file"), atomically: false, encoding: .utf8)
try "outside".write(to: outside, atomically: false, encoding: .utf8)
try fm.createSymbolicLink(at: stage.appendingPathComponent("Contents/external-link"), withDestinationURL: outside)

func run(_ command: String, _ args: [String]) throws -> Int32 {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: command)
    process.arguments = args
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    return process.terminationStatus
}
func quarantined(_ path: URL) throws -> Bool {
    try run("/usr/bin/xattr", ["-p", "com.apple.quarantine", path.path]) == 0
}
func privilegedCommand(_ mode: String) throws -> String {
    let process = Process()
    let output = Pipe()
    process.executableURL = installer
    process.arguments = [mode, stage.path, app.path, backup.path]
    process.standardOutput = output
    try process.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    precondition(process.terminationStatus == 0)
    return String(decoding: data, as: UTF8.self)
}
for path in [stage.appendingPathComponent("Contents"), stage.appendingPathComponent("Contents/version"), stage.appendingPathComponent("Contents/nested"), stage.appendingPathComponent("Contents/nested/file"), outside] {
    precondition(try! run("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;Updater Fixture;", path.path]) == 0)
}
try fm.setAttributes([.posixPermissions: 0o444], ofItemAtPath: stage.appendingPathComponent("Contents/nested/file").path)
try fm.setAttributes([.posixPermissions: 0o555], ofItemAtPath: stage.appendingPathComponent("Contents/nested").path)
func inode() throws -> UInt64 {
    (try fm.attributesOfItem(atPath: app.path)[.systemFileNumber] as! NSNumber).uint64Value
}
let before = try inode()
let bookmark = try app.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
precondition(try! run(installer.path, ["install", stage.path, app.path, backup.path]) == 0)
var stale = false
let resolved = try URL(resolvingBookmarkData: bookmark, options: [.withoutUI, .withoutMounting], relativeTo: nil, bookmarkDataIsStale: &stale)
let detail = "inodeBefore=\(before) inodeAfter=\(try inode()) stale=\(stale) resolved=\(resolved.path) expected=\(app.path)\n"
FileHandle.standardError.write(Data(detail.utf8))
precondition(try! inode() == before && !stale && resolved.resolvingSymlinksInPath().path == app.resolvingSymlinksInPath().path)
precondition(try! String(contentsOf: app.appendingPathComponent("Contents/version"), encoding: .utf8) == "new")
for path in [app.appendingPathComponent("Contents"), app.appendingPathComponent("Contents/version"), app.appendingPathComponent("Contents/nested"), app.appendingPathComponent("Contents/nested/file")] {
    precondition(try! !quarantined(path))
}
let readonlyFile = try fm.attributesOfItem(atPath: app.appendingPathComponent("Contents/nested/file").path)[.posixPermissions] as! NSNumber
let readonlyDirectory = try fm.attributesOfItem(atPath: app.appendingPathComponent("Contents/nested").path)[.posixPermissions] as! NSNumber
precondition(readonlyFile.intValue == 0o444 && readonlyDirectory.intValue == 0o555)
precondition(try! quarantined(outside), "Quarantine removal followed an external symlink")
precondition(!fm.fileExists(atPath: backup.path))

// Missing staging must fail without changing the installed version.
precondition(try! run(installer.path, ["install", root.appendingPathComponent("missing").path, app.path, backup.path]) != 0)
precondition(try! String(contentsOf: app.appendingPathComponent("Contents/version"), encoding: .utf8) == "new")
// Force the fallback's second rename to fail and verify rollback.
precondition(try! run(installer.path, ["fallback-failure", root.appendingPathComponent("missing").path, app.path, backup.path]) != 0)
precondition(try! String(contentsOf: app.appendingPathComponent("Contents/version"), encoding: .utf8) == "new")
precondition(!fm.fileExists(atPath: backup.path))
// The shell runs as administrator in production; make its fixture removable.
try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: app.appendingPathComponent("Contents/nested").path)
try fm.removeItem(at: stage.appendingPathComponent("Contents"))
try fm.createDirectory(at: stage.appendingPathComponent("Contents"), withIntermediateDirectories: true)
try "shell-new".write(to: stage.appendingPathComponent("Contents/version"), atomically: false, encoding: .utf8)
let shell = try privilegedCommand("privileged")
precondition(try! run("/bin/sh", ["-c", shell]) == 0, "Unprivileged execution of privileged shell failed")
precondition(try! inode() == before && String(contentsOf: app.appendingPathComponent("Contents/version"), encoding: .utf8) == "shell-new")
try fm.createDirectory(at: stage.appendingPathComponent("Contents"), withIntermediateDirectories: true)
let failingShell = try privilegedCommand("privileged-failure")
precondition(try! run("/bin/sh", ["-c", failingShell]) != 0)
precondition(try! inode() == before && String(contentsOf: app.appendingPathComponent("Contents/version"), encoding: .utf8) == "shell-new")
precondition(!fm.fileExists(atPath: backup.path))
let result: [String: Any] = ["status": "passed", "inodeBefore": before, "inodeAfter": try inode(), "bookmarkStale": stale, "quarantineRemoved": true, "readonlyPermissionsPreserved": true, "outsideQuarantinePreserved": true, "invalidStagePreservedApp": true, "fallbackRollback": true, "privilegedShellWithoutElevation": true, "privilegedShellFallbackRollback": true, "scope": "Native filesystem, bookmark and unprivileged shell integration; signed update, actual administrator elevation and visible Dock remain manual"]
let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
try data.write(to: resultPath)
print(String(decoding: data, as: UTF8.self))
