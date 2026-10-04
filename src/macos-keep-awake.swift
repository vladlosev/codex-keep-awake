// Standalone macOS wake helper. The supervisor holds its stdin pipe open for
// the duration of a lease; EOF or a handled termination signal restores power.

import Darwin
import Foundation
import IOKit
import IOKit.ps
import IOKit.pwr_mgt

let kPMSetClamshellSleepState: UInt32 = 12
let assertionReason = "Codex keep-awake lease" as CFString

let logFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()

func log(_ message: String) {
    let line = "[\(logFormatter.string(from: Date())) pid \(getpid())] \(message)\n"
    FileHandle.standardError.write(Data(line.utf8))
}

var assertionIDs: [IOPMAssertionID] = []
var pmConnection: io_connect_t = 0
var pmService: io_service_t = 0
var protectionActive = false
var cleanedUp = false
var powerSourceRunLoop: CFRunLoopSource?
var heartbeatTimer: DispatchSourceTimer?
var signalSources: [DispatchSourceSignal] = []

func createAssertions() {
    let assertions: [(CFString, String)] = [
        (kIOPMAssertionTypePreventUserIdleSystemSleep as CFString, "PreventUserIdleSystemSleep"),
        (kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString, "PreventUserIdleDisplaySleep"),
        (kIOPMAssertionTypePreventSystemSleep as CFString, "PreventSystemSleep")
    ]

    for (type, name) in assertions {
        var assertionID: IOPMAssertionID = 0
        let result = IOPMAssertionCreateWithName(
            type,
            IOPMAssertionLevel(kIOPMAssertionLevelOn),
            assertionReason,
            &assertionID
        )
        if result == kIOReturnSuccess {
            assertionIDs.append(assertionID)
            log("assertion \(name): acquired (id=\(assertionID))")
        } else {
            log("assertion \(name): failed (0x\(String(result, radix: 16)))")
        }
    }
}

func releaseAssertions() {
    for assertionID in assertionIDs {
        IOPMAssertionRelease(assertionID)
    }
    assertionIDs.removeAll()
}

func setClamshellSleep(disabled: Bool) {
    if pmConnection == 0 {
        pmService = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
        guard pmService != 0 else {
            log("clamshell control: IOPMrootDomain unavailable")
            return
        }

        let result = IOServiceOpen(pmService, mach_task_self_, 0, &pmConnection)
        guard result == KERN_SUCCESS else {
            log("clamshell control: IOServiceOpen failed (0x\(String(result, radix: 16)))")
            IOObjectRelease(pmService)
            pmService = 0
            return
        }
    }

    var input: UInt64 = disabled ? 1 : 0
    let result = IOConnectCallScalarMethod(pmConnection, kPMSetClamshellSleepState, &input, 1, nil, nil)
    if result == kIOReturnSuccess {
        log("clamshell sleep disabled=\(disabled)")
    } else {
        log("clamshell control failed (0x\(String(result, radix: 16)))")
    }
}

func closeClamshellHandles() {
    if pmConnection != 0 {
        IOServiceClose(pmConnection)
        pmConnection = 0
    }
    if pmService != 0 {
        IOObjectRelease(pmService)
        pmService = 0
    }
}

func reapplyPower() {
    guard protectionActive else { return }
    log("re-applying macOS power protection")
    releaseAssertions()
    createAssertions()
    setClamshellSleep(disabled: true)
}

func handlePowerSourceChange() {
    if protectionActive {
        reapplyPower()
    }
}

let powerSourceCallback: IOPowerSourceCallbackType = { _ in
    DispatchQueue.main.async {
        handlePowerSourceChange()
    }
}

let kIOMessageCanSystemSleepRaw: UInt32 = 0xE0000270
let kIOMessageSystemWillSleepRaw: UInt32 = 0xE0000280
let kIOMessageSystemHasPoweredOnRaw: UInt32 = 0xE0000300

var rootPowerPort: io_connect_t = 0
var rootPowerNotifier: io_object_t = 0
var rootPowerNotifyPort: IONotificationPortRef?

let systemPowerCallback: IOServiceInterestCallback = { _, _, messageType, argument in
    let token = Int(bitPattern: argument)
    switch messageType {
    case kIOMessageCanSystemSleepRaw:
        if protectionActive {
            log("system requested sleep; keeping the lease active")
            IOCancelPowerChange(rootPowerPort, token)
            DispatchQueue.main.async { reapplyPower() }
        } else {
            IOAllowPowerChange(rootPowerPort, token)
        }
    case kIOMessageSystemWillSleepRaw:
        IOAllowPowerChange(rootPowerPort, token)
    case kIOMessageSystemHasPoweredOnRaw:
        DispatchQueue.main.async { reapplyPower() }
    default:
        break
    }
}

func setupSystemPowerNotifications() {
    rootPowerPort = IORegisterForSystemPower(nil, &rootPowerNotifyPort, systemPowerCallback, &rootPowerNotifier)
    guard rootPowerPort != 0, let port = rootPowerNotifyPort else {
        log("system power notifications: registration failed")
        return
    }
    CFRunLoopAddSource(
        CFRunLoopGetMain(),
        IONotificationPortGetRunLoopSource(port).takeUnretainedValue(),
        CFRunLoopMode.defaultMode
    )
    log("system power notifications: subscribed")
}

func setupPowerSourceNotifications() {
    guard let source = IOPSCreateLimitedPowerNotification(powerSourceCallback, nil)?.takeRetainedValue() else {
        log("power source notifications: registration failed")
        return
    }
    powerSourceRunLoop = source
    CFRunLoopAddSource(CFRunLoopGetMain(), source, CFRunLoopMode.defaultMode)
    log("power source notifications: subscribed")
}

func installSignalHandlers() {
    for signalNumber in [SIGTERM, SIGINT, SIGHUP] {
        signal(signalNumber, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
        source.setEventHandler {
            log("received signal \(signalNumber); releasing lease")
            cleanup()
            exit(0)
        }
        source.resume()
        signalSources.append(source)
    }
}

func cleanup() {
    guard !cleanedUp else { return }
    cleanedUp = true
    protectionActive = false
    FileHandle.standardInput.readabilityHandler = nil
    heartbeatTimer?.cancel()
    heartbeatTimer = nil

    setClamshellSleep(disabled: false)
    releaseAssertions()
    closeClamshellHandles()

    if let source = powerSourceRunLoop {
        CFRunLoopRemoveSource(CFRunLoopGetMain(), source, CFRunLoopMode.defaultMode)
        powerSourceRunLoop = nil
    }
    if rootPowerNotifier != 0 {
        IODeregisterForSystemPower(&rootPowerNotifier)
        rootPowerNotifier = 0
    }
    if let port = rootPowerNotifyPort {
        IONotificationPortDestroy(port)
        rootPowerNotifyPort = nil
    }
    if rootPowerPort != 0 {
        IOServiceClose(rootPowerPort)
        rootPowerPort = 0
    }
    for source in signalSources {
        source.cancel()
    }
    signalSources.removeAll()
    log("lease released")
}

atexit { cleanup() }

log("macOS keep-awake lease starting")
installSignalHandlers()
protectionActive = true
reapplyPower()
setupSystemPowerNotifications()
setupPowerSourceNotifications()

let timer = DispatchSource.makeTimerSource(queue: .main)
timer.schedule(deadline: .now() + 30, repeating: 30)
timer.setEventHandler {
    if protectionActive {
        setClamshellSleep(disabled: true)
    }
}
timer.resume()
heartbeatTimer = timer

FileHandle.standardInput.readabilityHandler = { handle in
    if handle.availableData.isEmpty {
        handle.readabilityHandler = nil
        DispatchQueue.main.async {
            log("stdin lease closed")
            cleanup()
            CFRunLoopStop(CFRunLoopGetMain())
        }
    }
}

CFRunLoopRun()
cleanup()
