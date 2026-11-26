'use strict';

const worker = String.raw`
import hashlib
import json
import os
import pathlib
import signal
import socket
import stat
import subprocess
import sys
import threading


def physical(path):
    if path.resolve(strict=True) != path:
        raise ValueError("Use physical Linux project, source and JAR paths.")
    return path


def digest(path, limit):
    physical(path)
    with path.open("rb") as file:
        before = os.fstat(file.fileno())
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= limit:
            raise ValueError("The selected Java input must be a bounded regular file.")
        value = hashlib.file_digest(file, "sha256").hexdigest()
        after = path.lstat()
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns
        ):
            raise ValueError("A Java debug input changed during review.")
        return value


def relay(listener):
    sys.stdout.buffer.write(b"ROCKETBRAIN_JDWP_PREPARED\n")
    sys.stdout.buffer.flush()
    if os.read(sys.stdin.fileno(), 1) != b"1":
        return
    with listener.accept()[0] as target:
        listener.close()
        sys.stdout.buffer.write(b"ROCKETBRAIN_JDWP_READY\n")
        sys.stdout.buffer.flush()

        def send():
            try:
                while data := os.read(sys.stdin.fileno(), 65536):
                    target.sendall(data)
            except OSError:
                pass
            finally:
                try:
                    target.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

        threading.Thread(target=send, daemon=True).start()
        while data := target.recv(65536):
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()


def main():
    request = json.loads(sys.argv[1])
    root = physical(pathlib.Path(request["linux"]))
    directory = root.stat()
    if f"{directory.st_dev}:{directory.st_ino}" != request["directoryIdentity"]:
        raise ValueError("The WSL project directory changed after review.")
    source = physical(root / request["source"])
    jar = physical(root / request["jar"])
    java = pathlib.Path("/usr/bin/java").resolve(strict=True)
    release = java.parent.parent / "release"
    proof = {"source": digest(source, 256 * 1024), "jar": digest(jar, 512 * 1024 * 1024),
             "java": str(java), "runtime": digest(java, 16 * 1024 * 1024), "release": digest(release, 128 * 1024)}
    if request.get("expected") is None:
        print(json.dumps(proof), flush=True)
        return
    if request["expected"] != proof:
        raise ValueError("The WSL Java source, JAR or JDK changed after review.")
    environment = {key: value for key, value in os.environ.items() if key not in
                   ("JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS", "CLASSPATH")}
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(15)
        port = listener.getsockname()[1]
        option = f"-agentlib:jdwp=transport=dt_socket,server=n,suspend=y,address=127.0.0.1:{port},timeout=15000"
        process = subprocess.Popen([str(java), option, "-jar", str(jar)], cwd=root, env=environment,
                                   stdin=subprocess.DEVNULL, stdout=sys.stderr, start_new_session=True)
        try:
            relay(listener)
        finally:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            process.wait()


try:
    main()
except (OSError, ValueError, KeyError) as error:
    sys.exit(str(error))
`;

module.exports = { worker };
