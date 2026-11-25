"""Serve one owned, loopback Jupyter kernel for Rocketbrain's notebook editor."""

import json
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


def execute(client, manager, request):
    code = request.get("code")
    run_id = request["id"]
    if not isinstance(code, str) or len(code.encode("utf-8")) > 384 * 1024:
        raise ValueError("Run a Python notebook cell up to 384 KiB.")
    message_id = client.execute(code, allow_stdin=False, stop_on_error=True)
    deadline = time.monotonic() + 60
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
                manager.interrupt_kernel()
                cancelled = True
                deadline = min(deadline, time.monotonic() + 6)
            elif pending.get("op") == "shutdown":
                STOP.set()
                break
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
    STOP.set()
    if cancelled:
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
        root = pathlib.Path(temporary)
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
            manager.start_kernel(cwd=directory, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            client = manager.client()
            client.start_channels(stdin=False)
            client.wait_for_ready(timeout=20)
            send({"ready": True, "language": "python", "version": sys.version.split()[0]})
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
                if operation != "execute":
                    send({"id": request["id"], "error": "Unsupported notebook bridge operation."})
                    continue
                try:
                    send(execute(client, manager, request))
                except (RuntimeError, ValueError, KeyError, TypeError) as error:
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
