"""Fixed Xcode LLDB worker for one explicitly reviewed simulator process."""

import json
import os
import re

import lldb


PREFIX = "ROCKETBRAIN_IOS:"
SCALAR = re.compile(r"^(?:true|false|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|nan|[+-]?inf)$", re.I)


def emit(event, **body):
    # The embedded interpreter can buffer Python stdout as LLDB command output.
    # Send the live debugger state on the inherited process pipe instead.
    os.write(1, (PREFIX + json.dumps(dict(event=event, **body)) + "\n").encode("utf-8"))


def checked(error, description):
    if not error.Success():
        raise RuntimeError(description + ": " + (error.GetCString() or "unknown LLDB error"))


def real_file(file_spec):
    value = file_spec.fullpath
    return os.path.realpath(value) if value and os.path.isabs(value) else None


def source_at(line_entry, source, line):
    return line_entry.IsValid() and line_entry.GetLine() == line and real_file(line_entry.GetFileSpec()) == source


def inspect_locals(frame):
    values = frame.GetVariables(False, True, False, True, lldb.eNoDynamicValues)
    result = []
    for index in range(min(values.GetSize(), 32)):
        value = values.GetValueAtIndex(index)
        value.SetPreferDynamicValue(lldb.eNoDynamicValues)
        value.SetPreferSyntheticValue(False)
        type_info = value.GetType().GetCanonicalType()
        if type_info.IsPointerType() or type_info.IsReferenceType() or type_info.GetByteSize() not in (1, 2, 4, 8):
            continue
        if not (type_info.GetTypeFlags() & lldb.eTypeIsScalar):
            continue
        name, text, type_name = value.GetName(), value.GetValue(), value.GetTypeName()
        if name and type_name and text and len(text) < 64 and SCALAR.fullmatch(text):
            result.append(dict(name=name[:100], type=type_name[:100], value=text))
    return result


def quoted_lldb_path(file):
    if not os.path.isabs(file) or chr(96) in file or any(ord(char) < 32 for char in file):
        raise RuntimeError("The reviewed symbol path cannot be passed to LLDB.")
    return '"' + file.replace("\\", "\\\\").replace('"', '\\"') + '"'


def load_reviewed_symbols(debugger, target, plan, module=None):
    if module is None:
        module = target.AddModule(plan["framework"], "arm64", plan["frameworkUuid"], plan["symbols"])
    if not module.IsValid() or (module.GetUUIDString() or "").lower() != plan["frameworkUuid"]:
        raise RuntimeError("LLDB did not load the reviewed Kotlin framework.")
    if real_file(module.GetSymbolFileSpec()) != os.path.realpath(plan["symbols"]):
        result = lldb.SBCommandReturnObject()
        # LLDB binds the symbol file to a target module by the Mach-O UUID.
        debugger.GetCommandInterpreter().HandleCommand("target symbols add -- " + quoted_lldb_path(plan["symbols"]), result)
        if not result.Succeeded():
            raise RuntimeError("LLDB refused the reviewed Kotlin symbols: " + (result.GetError() or "unknown reason")[:400])
        module = target.FindModule(lldb.SBFileSpec(plan["framework"]))
    if (not module.IsValid() or (module.GetUUIDString() or "").lower() != plan["frameworkUuid"]
            or real_file(module.GetFileSpec()) != plan["framework"]
            or real_file(module.GetSymbolFileSpec()) != os.path.realpath(plan["symbols"])):
        raise RuntimeError("LLDB did not bind the reviewed symbol file to the exact installed framework.")
    return module


def compiled_addresses(module, plan):
    candidates = {}
    file = lldb.SBFileSpec(plan["source"])
    count = module.GetNumCompileUnits()
    if count > 4096:
        raise RuntimeError("The reviewed Kotlin framework exceeds the compile-unit inspection limit.")
    for unit_index in range(count):
        unit = module.GetCompileUnitAtIndex(unit_index)
        start = 0
        matches = 0
        while matches < 32:
            index = unit.FindLineEntryIndex(start, plan["line"], file, True)
            if index == lldb.LLDB_INVALID_INDEX32:
                break
            if index < start or len(candidates) == 32:
                raise RuntimeError("The exact Kotlin source line has too many generated locations.")
            start = index + 1
            matches += 1
            entry = unit.GetLineEntryAtIndex(index)
            address = entry.GetStartAddress()
            if (source_at(entry, plan["source"], plan["line"]) and address.IsValid()
                    and (address.GetModule().GetUUIDString() or "").lower() == plan["frameworkUuid"]):
                candidates[address.GetFileAddress()] = address
        else:
            raise RuntimeError("The exact Kotlin source line has too many generated locations.")
    return candidates


def exact_address(target, module, plan):
    files = lldb.SBFileSpecList()
    files.Append(module.GetFileSpec())
    resolver = target.BreakpointCreateByLocation(lldb.SBFileSpec(plan["source"]), plan["line"], 0, 0, files, False)
    resolved = resolver.GetNumLocations()
    candidates = {}
    try:
        if resolved > 32:
            raise RuntimeError("The reviewed Kotlin source line has too many native resolver locations.")
        for index in range(resolved):
            address = resolver.GetLocationAtIndex(index).GetAddress()
            if ((address.GetModule().GetUUIDString() or "").lower() == plan["frameworkUuid"]
                    and source_at(address.GetLineEntry(), plan["source"], plan["line"])):
                candidates[address.GetFileAddress()] = address
    finally:
        target.BreakpointDelete(resolver.GetID())
    if not candidates:
        candidates = compiled_addresses(module, plan)
    if not candidates:
        raise RuntimeError("No exact Kotlin DWARF line in the reviewed framework (resolver locations: "
                           + str(resolved) + ", compile units: " + str(module.GetNumCompileUnits()) + ").")
    functions = [address.GetFunction() for address in candidates.values()]
    if (len(candidates) > 1 and (not all(function.IsValid() for function in functions)
            or len({function.GetStartAddress().GetFileAddress() for function in functions}) != 1)):
        raise RuntimeError("The Kotlin line maps to distinct native functions; choose an unambiguous source line.")
    return candidates[min(candidates)]


def live_framework_address(target, plan, file_address):
    if target.GetNumModules() > 4096:
        raise RuntimeError("The live simulator module count exceeds the ownership inspection limit.")
    matches = []
    for module in target.modules:
        if ((module.GetUUIDString() or "").lower() != plan["frameworkUuid"]
                or real_file(module.GetFileSpec()) != plan["framework"]):
            continue
        candidate = module.ResolveFileAddress(file_address)
        if candidate.IsValid() and candidate.GetLoadAddress(target) != lldb.LLDB_INVALID_ADDRESS:
            matches.append((module, candidate))
    if len(matches) > 1:
        raise RuntimeError("More than one runtime module matches the reviewed Kotlin framework.")
    return matches[0] if matches else None


def set_loader_stops(debugger, enabled):
    result = lldb.SBCommandReturnObject()
    fixed = "settings set target.process.stop-on-sharedlibrary-events " + ("true" if enabled else "false")
    debugger.GetCommandInterpreter().HandleCommand(fixed, result)
    if not result.Succeeded():
        raise RuntimeError("Stock LLDB could not select the private loader-event mode.")


def loader_stop(process):
    reasons = []
    for thread in process:
        reason = thread.GetStopReason()
        if reason in (lldb.eStopReasonNone, lldb.eStopReasonInvalid):
            continue
        description = (thread.GetStopDescription(160) or "").lower()
        frame = thread.GetFrameAtIndex(0)
        file = real_file(frame.GetModule().GetFileSpec()) or ""
        reasons.append(reason == getattr(lldb, "eStopReasonDynamicLoader", -1) or
                       (reason == lldb.eStopReasonBreakpoint and
                        ("shared-library-event" in description or file.endswith("/usr/lib/dyld"))))
    return bool(reasons) and all(reasons)


def wait_for_runtime_address(debugger, target, process, plan, compiled):
    file_address = compiled.GetFileAddress()
    live = live_framework_address(target, plan, file_address)
    if live is None:
        emit("phase", stage="runtime-framework-pending")
        set_loader_stops(debugger, True)
        try:
            for _ in range(16):
                checked(process.Continue(), "Could not run the owned app to its native loader event")
                if process.GetState() != lldb.eStateStopped or not loader_stop(process):
                    raise RuntimeError("The owned simulator app did not stop at a recognized dynamic-loader event.")
                emit("phase", stage="runtime-loader-stopped")
                live = live_framework_address(target, plan, file_address)
                if live is not None:
                    break
        finally:
            set_loader_stops(debugger, False)
    if live is None:
        raise RuntimeError("The reviewed Kotlin framework did not map into the owned app at a loader event.")
    module, _ = live
    load_reviewed_symbols(debugger, target, plan, module)
    live = live_framework_address(target, plan, file_address)
    if live is None or not source_at(live[1].GetLineEntry(), plan["source"], plan["line"]):
        raise RuntimeError("The live Kotlin address did not match the reviewed framework UUID and exact source.")
    emit("phase", stage="runtime-framework-mapped")
    return live[1]


def run(plan):
    emit("phase", stage="interpreter-entered")
    debugger = lldb.debugger
    debugger.SetAsync(False)
    debugger.HandleCommand("settings set target.load-script-from-symbol-file false")
    target = debugger.CreateTarget(plan["executable"])
    if not target.IsValid():
        raise RuntimeError("Could not open the reviewed simulator Mach-O app.")
    emit("phase", stage="target-opened")
    error = lldb.SBError()
    emit("phase", stage="attaching")
    process = target.AttachToProcessWithID(debugger.GetListener(), plan["pid"], error)
    checked(error, "macOS refused stock LLDB attachment to the owned simulator PID")
    if not process.IsValid() or process.GetProcessID() != plan["pid"]:
        raise RuntimeError("LLDB did not attach to the reviewed simulator PID.")
    info = process.GetProcessInfo()
    if not info.IsValid() or real_file(info.GetExecutableFile()) != plan["executable"]:
        raise RuntimeError("LLDB did not observe the reviewed simulator executable.")
    emit("phase", stage="process-verified")
    module = load_reviewed_symbols(debugger, target, plan)
    emit("phase", stage="module-verified")
    address = wait_for_runtime_address(debugger, target, process, plan, exact_address(target, module, plan))
    breakpoint = target.BreakpointCreateBySBAddress(address)
    if not breakpoint.IsValid() or breakpoint.GetNumLocations() != 1:
        raise RuntimeError("LLDB did not bind the exact Mach-O-relative Kotlin breakpoint address.")
    location = breakpoint.GetLocationAtIndex(0)
    if location.GetAddress().GetLoadAddress(target) != address.GetLoadAddress(target):
        raise RuntimeError("LLDB armed a different address from the live reviewed Kotlin breakpoint.")
    emit("phase", stage="runtime-breakpoint-resolved" if location.IsResolved() else "runtime-breakpoint-pending")
    emit("ready")
    emit("phase", stage="process-continue")
    checked(process.Continue(), "Could not run the owned simulator app to its Kotlin breakpoint")
    emit("phase", stage="process-continue-returned")
    if process.GetState() != lldb.eStateStopped:
        raise RuntimeError("The simulator app did not stop at a Kotlin source breakpoint.")
    frames = []
    for thread in process:
        if thread.GetStopReason() != lldb.eStopReasonBreakpoint or not thread.GetStopReasonDataCount():
            continue
        if thread.GetStopReasonDataAtIndex(0) != breakpoint.GetID():
            continue
        frame = thread.GetFrameAtIndex(0)
        if ((frame.GetModule().GetUUIDString() or "").lower() == plan["frameworkUuid"]
                and source_at(frame.GetLineEntry(), plan["source"], plan["line"])):
            frames.append(frame)
    if len(frames) != 1:
        raise RuntimeError("The stopped frame did not match the reviewed Kotlin breakpoint and module.")
    frame = frames[0]
    emit("stopped", source=plan["source"], line=plan["line"],
         name=(frame.GetFunctionName() or "Kotlin")[:200], locals=inspect_locals(frame))
    with os.fdopen(0, "r", closefd=False) as incoming:
        command = incoming.readline(32)
    if command.strip() != "continue":
        return
    target.BreakpointDelete(breakpoint.GetID())
    checked(process.Detach(False), "Could not continue and detach from the owned simulator app")
    emit("continued")


try:
    run(json.loads(os.environ["ROCKETBRAIN_IOS_PLAN"]))
except (RuntimeError, ValueError, TypeError, AttributeError) as failure:
    emit("error", message=str(failure)[:1200])
