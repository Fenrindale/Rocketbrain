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


def installed_location(target, module, plan):
    files = lldb.SBFileSpecList()
    files.Append(module.GetFileSpec())
    breakpoint = target.BreakpointCreateByLocation(lldb.SBFileSpec(plan["source"]), plan["line"], 0, 0, files, False)
    exact = []
    for index in range(breakpoint.GetNumLocations()):
        location = breakpoint.GetLocationAtIndex(index)
        address = location.GetAddress()
        if ((address.GetModule().GetUUIDString() or "").lower() == plan["frameworkUuid"]
                and source_at(address.GetLineEntry(), plan["source"], plan["line"])):
            exact.append(location)
        else:
            location.SetEnabled(False)
    # The dynamic framework can still be pending while dyld is waiting for the debugger.
    # Accept a unique Mach-O-relative DWARF address and verify the live module on the stop.
    if len(exact) != 1:
        raise RuntimeError("Expected one DWARF location for the exact reviewed Kotlin source and line.")
    return breakpoint


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
    module = target.AddModule(plan["framework"], "arm64", plan["frameworkUuid"], plan["symbols"])
    if not module.IsValid() or (module.GetUUIDString() or "").lower() != plan["frameworkUuid"]:
        raise RuntimeError("LLDB did not load the reviewed Kotlin framework and dSYM.")
    emit("phase", stage="module-verified")
    breakpoint = installed_location(target, module, plan)
    emit("ready")
    checked(process.Continue(), "Could not run the owned simulator app to its Kotlin breakpoint")
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
