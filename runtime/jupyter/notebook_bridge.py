"""Serve one owned, loopback Jupyter kernel for Rocketbrain's notebook editor."""

import importlib.util
import json
import os
import pathlib
import queue
import subprocess
import sys
import tempfile
import threading
import time

from jupyter_client import KernelManager
from jupyter_client.kernelspec import KernelSpecManager


LIMIT = 1024 * 1024
INBOX = queue.Queue(maxsize=16)
STOP = threading.Event()
ACCEPTED_MIMES = frozenset(("text/plain", "image/png", "application/json"))


def send(payload):
    encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
    if len(encoded) > 2 * LIMIT:
        raise ValueError("Notebook bridge result exceeds its output limit.")
    sys.stdout.buffer.write(encoded + b"\n")
    sys.stdout.buffer.flush()


def read_commands():
    while not STOP.is_set():
        raw = sys.stdin.buffer.readline(LIMIT + 1)
        if not raw or len(raw) > LIMIT:
            break
        try:
            item = json.loads(raw)
            if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                break
            INBOX.put(item, timeout=1)
        except (ValueError, queue.Full):
            break
    STOP.set()


def output_for(message):
    name = message["msg_type"]
    content = message["content"]
    if name == "stream":
        return {"output_type": "stream", "name": content["name"], "text": content["text"]}
    if name == "error":
        return {"output_type": "error", "ename": content["ename"], "evalue": content["evalue"],
                "traceback": content["traceback"]}
    if name not in ("display_data", "execute_result"):
        return None
    data = {mime: value for mime, value in content.get("data", {}).items() if mime in ACCEPTED_MIMES}
    if not data:
        return None
    output = {"output_type": name, "data": data, "metadata": {}}
    if name == "execute_result":
        output["execution_count"] = content.get("execution_count")
    return output


class NotebookDebugger:
    def __init__(self, client, root, run_id):
        self.client = client
        self.root = root
        self.run_id = run_id
        self.sequence = 0
        self.pause = 0
        self.frame = None
        self.thread = None
        self.path = None
        self.started = False
        self.stepping = False
        self.line = None

    def request(self, command, arguments=None):
        self.sequence += 1
        request = self.client.session.msg("debug_request", content={
            "type": "request", "command": command, "seq": self.sequence, "arguments": arguments or {}
        })
        self.client.control_channel.send(request)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline and not STOP.is_set():
            try:
                reply = self.client.get_control_msg(timeout=0.2)
            except queue.Empty:
                continue
            if reply.get("parent_header", {}).get("msg_id") != request["header"]["msg_id"]:
                continue
            body = reply.get("content", {})
            if (reply.get("msg_type") != "debug_reply" or body.get("type") != "response"
                    or body.get("command") != command or body.get("request_seq") != self.sequence
                    or body.get("success") is not True):
                raise RuntimeError("The Python debugger did not confirm " + command + ".")
            return body.get("body", {})
        raise RuntimeError("The Python debugger did not answer " + command + " in time.")

    def breakpoints(self, positions):
        return self.request("setBreakpoints", {
            "source": {"path": str(self.path), "name": "Notebook cell"},
            "breakpoints": positions, "sourceModified": False
        }).get("breakpoints", [])

    def prepare(self, code, line):
        self.line = line
        self.started = True
        self.request("initialize", {"adapterID": "python", "clientID": "rocketbrain",
                     "linesStartAt1": True, "columnsStartAt1": True, "pathFormat": "path"})
        self.request("attach", {"justMyCode": True, "redirectOutput": False, "subProcess": False})
        reported = pathlib.Path(self.request("dumpCell", {"code": code})["sourcePath"])
        self.path = reported.resolve(strict=True)
        if (not self.path.is_relative_to(self.root) or self.path.suffix != ".py"
                or not self.path.is_file() or self.path.stat().st_size > 2 * LIMIT
                or self.path.read_text(encoding="utf-8") != code.replace("\r\n", "\n")):
            self.path = None
            raise ValueError("The Python debugger did not bind the exact notebook cell source.")
        registered = self.breakpoints([{"line": line}])
        if len(registered) != 1 or registered[0].get("verified") is not True or registered[0].get("line") != line:
            raise ValueError("Choose an executable Python line for the cell breakpoint.")
        reported_source = registered[0].get("source", {}).get("path")
        if reported_source and pathlib.Path(reported_source).resolve() != self.path:
            raise ValueError("The Python debugger registered the breakpoint outside the selected cell.")
        self.request("configurationDone")

    def event(self, content):
        if content.get("event") != "stopped":
            return
        body = content.get("body", {})
        thread = body.get("threadId")
        if type(thread) is not int or thread < 1:
            raise RuntimeError("The Python debugger returned an invalid stopped thread.")
        frames = self.request("stackTrace", {"threadId": thread, "startFrame": 0, "levels": 1}).get("stackFrames", [])
        frame = frames[0] if frames else {}
        source = frame.get("source", {}).get("path")
        position = frame.get("line")
        reason = body.get("reason")
        at_selection = reason == "breakpoint" and position == self.line
        at_step = reason == "step" and self.stepping
        if (not isinstance(source, str) or not pathlib.Path(source).is_absolute()
                or pathlib.Path(source).resolve() != self.path or type(position) is not int or position < 1
                or type(frame.get("id")) is not int or not (at_selection or at_step)):
            self.request("continue", {"threadId": thread})
            self.stepping = False
            return
        self.pause += 1
        self.thread = thread
        self.frame = frame["id"]
        self.stepping = False
        send({"id": self.run_id, "debug": {"state": "paused", "pause": self.pause, "line": position, "reason": reason}})

    def action(self, pending):
        if (pending.get("for") != self.run_id or self.thread is None or pending.get("pause") != self.pause
                or pending.get("action") not in ("locals", "next", "continue")):
            raise ValueError("Select the current paused Python notebook cell.")
        op = pending["action"]
        if op == "locals":
            scopes = self.request("scopes", {"frameId": self.frame}).get("scopes", [])
            scope = next((item for item in scopes if item.get("presentationHint") == "locals"), None)
            if not scope or type(scope.get("variablesReference")) is not int:
                raise RuntimeError("The Python debugger did not return a local scope.")
            values = self.request("variables", {"variablesReference": scope["variablesReference"],
                                  "start": 0, "count": 80}).get("variables", [])
            variables = [{"name": item["name"][:120], "value": item["value"][:600], "type": item.get("type", "")[:120]}
                         for item in values[:80] if isinstance(item.get("name"), str) and isinstance(item.get("value"), str)
                         and isinstance(item.get("type", ""), str) and item["name"].isidentifier()]
            return {"state": "paused", "pause": self.pause, "variables": variables}
        self.request(op, {"threadId": self.thread})
        self.thread = None
        self.frame = None
        self.stepping = op == "next"
        return {"state": "running"}

    def finish(self):
        if self.started and not STOP.is_set():
            try:
                if self.path is not None:
                    self.breakpoints([])
                self.request("disconnect", {"restart": False, "terminateDebuggee": False})
            except (RuntimeError, ValueError, KeyError, TypeError, OSError):
                STOP.set()


def execute(client, manager, request, debugger=None):
    code = request.get("code")
    run_id = request["id"]
    if not isinstance(code, str) or len(code.encode("utf-8")) > 384 * 1024:
        raise ValueError("Run a Python notebook cell up to 384 KiB.")
    if debugger:
        line = request.get("line")
        if type(line) is not int or not 1 <= line <= len(code.split("\n")):
            raise ValueError("Choose an executable Python line in this cell.")
        debugger.prepare(code, line)
        try:
            pending = INBOX.get_nowait()
            if pending.get("op") == "shutdown" or (pending.get("op") == "cancel" and pending.get("for") == run_id):
                STOP.set()
            else:
                send({"id": pending["id"], "error": "A different notebook cell is already running."})
        except queue.Empty:
            pass
        if STOP.is_set():
            return {"id": run_id, "outputs": [], "success": False, "cancelled": True, "kernelStopped": True}
    message_id = client.execute(code, allow_stdin=False, stop_on_error=True)
    deadline = time.monotonic() + (180 if debugger else 60)
    outputs = []
    output_bytes = 0
    count = None
    cancelled = False
    truncated = False
    clear_before_output = False
    while not STOP.is_set() and time.monotonic() < deadline:
        try:
            pending = INBOX.get_nowait()
            if pending.get("op") == "cancel" and pending.get("for") == run_id and not cancelled:
                cancelled = True
                if debugger:
                    STOP.set()
                    break
                manager.interrupt_kernel()
                deadline = min(deadline, time.monotonic() + 6)
            elif pending.get("op") == "shutdown":
                STOP.set()
                break
            elif pending.get("op") == "debug-action" and debugger:
                try:
                    send({"id": pending["id"], "debug": debugger.action(pending)})
                except ValueError as error:
                    send({"id": pending["id"], "error": str(error)[:1000]})
                except (RuntimeError, KeyError, TypeError) as error:
                    send({"id": pending["id"], "error": str(error)[:1000]})
                    STOP.set()
                    raise
            else:
                send({"id": pending["id"], "error": "A different notebook cell is already running."})
        except queue.Empty:
            pass
        try:
            message = client.get_iopub_msg(timeout=0.15)
        except queue.Empty:
            if not manager.is_alive():
                raise RuntimeError("The notebook kernel exited during the cell.")
            continue
        if debugger and message.get("msg_type") == "debug_event":
            try:
                debugger.event(message["content"])
            except (RuntimeError, ValueError, KeyError, TypeError, OSError):
                STOP.set()
                raise
            continue
        if message.get("parent_header", {}).get("msg_id") != message_id:
            continue
        name = message["msg_type"]
        content = message["content"]
        if name == "execute_input":
            count = content.get("execution_count")
        if name == "clear_output":
            clear_before_output = bool(content.get("wait"))
            if not clear_before_output:
                outputs.clear()
                output_bytes = 0
        output = output_for(message)
        if output:
            if clear_before_output:
                outputs.clear()
                output_bytes = 0
                clear_before_output = False
            size = len(json.dumps(output, ensure_ascii=False).encode("utf-8"))
            if len(outputs) < 500 and output_bytes + size <= LIMIT:
                outputs.append(output)
                output_bytes += size
            else:
                truncated = True
        if name == "status" and content.get("execution_state") == "idle":
            reply = shell_reply(client, message_id)
            return {"id": run_id, "outputs": outputs, "executionCount": count,
                    "success": reply.get("status") == "ok" and not cancelled,
                    "cancelled": cancelled, "truncated": truncated}
    stopped = STOP.is_set()
    STOP.set()
    if cancelled or debugger and stopped:
        return {"id": run_id, "outputs": outputs, "executionCount": count, "success": False,
                "cancelled": True, "truncated": truncated, "kernelStopped": True}
    return {"id": run_id, "error": "The notebook cell exceeded its time limit or the kernel was shut down."}


def shell_reply(client, request_id):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            reply = client.get_shell_msg(timeout=0.2)
        except queue.Empty:
            continue
        if reply.get("parent_header", {}).get("msg_id") == request_id:
            return reply["content"]
    raise RuntimeError("The notebook kernel did not acknowledge the completed cell.")


def serve(directory):
    with tempfile.TemporaryDirectory(prefix="rocketbrain-notebook-") as temporary:
        root = pathlib.Path(temporary).resolve(strict=True)
        kernel_name = "rocketbrain-python"
        kernels = root / "kernels"
        spec_path = kernels / kernel_name
        spec_path.mkdir(parents=True)
        (spec_path / "kernel.json").write_text(json.dumps({
            "argv": [sys.executable, "-I", "-m", "ipykernel_launcher", "-f", "{connection_file}"],
            "display_name": "Rocketbrain Python", "language": "python"
        }), encoding="utf-8")
        manager = KernelManager(kernel_name=kernel_name, kernel_spec_manager=KernelSpecManager(kernel_dirs=[str(kernels)]),
                                connection_file=str(root / "connection.json"), transport="tcp", ip="127.0.0.1")
        client = None
        try:
            env = {key: value for key, value in os.environ.items()
                   if key.upper() not in ("IPYKERNEL_CELL_NAME", "DEBUGPY_LOG_DIR")}
            env.update({key: str(root) for key in ("TMP", "TEMP", "TMPDIR")})
            manager.start_kernel(cwd=directory, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            client = manager.client()
            client.start_channels(stdin=False)
            client.wait_for_ready(timeout=20)
            can_debug = importlib.util.find_spec("debugpy") is not None
            send({"ready": True, "language": "python", "version": sys.version.split()[0], "debugger": can_debug})
            while not STOP.is_set():
                try:
                    request = INBOX.get(timeout=0.2)
                except queue.Empty:
                    if not manager.is_alive():
                        break
                    continue
                operation = request.get("op")
                if operation == "shutdown":
                    break
                if operation == "cancel":
                    continue
                if operation not in ("execute", "debug"):
                    send({"id": request["id"], "error": "Unsupported notebook bridge operation."})
                    continue
                debugger = NotebookDebugger(client, root, request["id"]) if operation == "debug" and can_debug else None
                if operation == "debug" and debugger is None:
                    send({"id": request["id"], "error": "Install debugpy in the selected notebook Python environment."})
                    continue
                try:
                    try:
                        result = execute(client, manager, request, debugger)
                    finally:
                        if debugger:
                            debugger.finish()
                    if debugger and STOP.is_set() and "outputs" in result:
                        result["kernelStopped"] = True
                    send(result)
                except (RuntimeError, ValueError, KeyError, TypeError, OSError) as error:
                    send({"id": request["id"], "error": str(error)[:1000]})
        finally:
            if client:
                client.stop_channels()
            if manager.has_kernel:
                manager.shutdown_kernel(now=True)


if __name__ == "__main__":
    thread = threading.Thread(target=read_commands, daemon=True)
    thread.start()
    serve(str(pathlib.Path(sys.argv[1]).resolve(strict=True)))
