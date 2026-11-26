'use strict';

const { deflateSync } = require('node:zlib');

const probeJava = String.raw`
import com.sun.tools.attach.VirtualMachine;
import java.nio.file.Path;

class RocketbrainSshJvm {
    public static void main(String[] args) throws Exception {
        long pid = Long.parseLong(args[0]);
        var process = ProcessHandle.of(pid).orElseThrow();
        var identity = process.info();
        var owner = ProcessHandle.current().info().user().orElseThrow();
        if (!process.isAlive() || !owner.equalsIgnoreCase(identity.user().orElse("")) ||
                !Path.of(identity.command().orElseThrow()).getFileName().toString().equalsIgnoreCase("java.exe")) {
            throw new IllegalArgumentException("The reviewed process is not a Java JVM of this account");
        }
        var vm = VirtualMachine.attach(Long.toString(pid));
        try {
            if (!vm.getAgentProperties().getProperty("sun.jdwp.listenerAddress", "").equals("dt_socket:" + args[1]) ||
                    !Path.of(vm.getSystemProperties().getProperty("user.dir", "")).toRealPath().equals(Path.of(args[2]).toRealPath())) {
                throw new IllegalArgumentException("The JVM debug port or reported project directory changed");
            }
            System.out.println(identity.startInstant().orElseThrow().toEpochMilli());
        } finally {
            vm.detach();
        }
    }
}
`;

const debugSupervisor = String.raw`import ctypes, hashlib, json, os, pathlib, socket, struct, subprocess, sys, tempfile, threading

control = sys.stdin.buffer.readline(16385)
if not control.endswith(b"\n") or len(control) > 16384:
    raise ValueError("The SSH debug request exceeded its input limit")
mode, root_value, java_value, pid_value, port_value, expected, probe_source = json.loads(control)
if sys.platform != "win32" or mode not in ("inspect", "relay"):
    raise ValueError("Use a Windows SSH host for reviewed Java attach")
if type(pid_value) is not int or not 1 <= pid_value <= 4294967295 or type(port_value) is not int or not 1 <= port_value <= 65535:
    raise ValueError("Choose an exact JVM process ID and debug port")
pid, port = pid_value, port_value
env = {key: value for key, value in os.environ.items() if key.upper() not in (
    "CLASSPATH", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "JDK_JAVAC_OPTIONS")}

def directory(value):
    item = pathlib.Path(value)
    if not item.is_absolute() or item.resolve(strict=True) != item or not item.is_dir():
        raise ValueError("Use a physical Java and workspace directory")
    return item

root, java_home = directory(root_value), directory(java_value)
java = java_home / "bin" / "java.exe"
release = java_home / "release"
if java.resolve(strict=True) != java or release.resolve(strict=True) != release:
    raise ValueError("Use a physical independent JDK")
def fingerprint():
    digest = hashlib.sha256()
    for file in (java, release):
        if not file.is_file() or file.stat().st_size > 1048576:
            raise ValueError("Invalid remote JDK file")
        digest.update(file.read_bytes())
    info = release.read_text(encoding="utf-8")
    if not any(line.startswith('JAVA_VERSION="25.') for line in info.splitlines()) or "jetbrains" in info.lower():
        raise ValueError("Use an independent JDK 25")
    return digest.hexdigest()

# Windows MIB_TCPROW_OWNER_PID and MIB_TCP6ROW_OWNER_PID have DWORD alignment.
tcp_table = ctypes.WinDLL("iphlpapi").GetExtendedTcpTable
kernel = ctypes.WinDLL("kernel32")
kernel.OpenProcess.restype = ctypes.c_void_p
kernel.CloseHandle.argtypes = [ctypes.c_void_p]
kernel.GetProcessTimes.argtypes = [ctypes.c_void_p] * 5
loopback = int.from_bytes(socket.inet_aton("127.0.0.1"), "little")

def rows(family, layout):
    size = ctypes.c_uint32(0)
    for _ in range(4):
        buffer = ctypes.create_string_buffer(size.value) if size.value else None
        status = tcp_table(buffer, ctypes.byref(size), 0, family, 5, 0)  # TCP_TABLE_OWNER_PID_ALL
        if status == 0 and buffer is not None:
            count = struct.unpack_from("<I", buffer)[0]
            end = 4 + count * layout.size
            if end > len(buffer):
                break
            return layout.iter_unpack(buffer[4:end])
        if status != 122 or not 4 <= size.value <= 4 * 1048576:
            break
    raise ValueError("The Windows TCP ownership table is unavailable")

def observed_start():
    process = kernel.OpenProcess(0x1000, 0, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not process:
        raise ValueError("The reviewed Windows process is unavailable")
    times = [ctypes.c_uint64() for _ in range(4)]
    try:
        if not kernel.GetProcessTimes(process, *(ctypes.byref(value) for value in times)) or times[1].value:
            raise ValueError("The reviewed Windows process exited")
        return (times[0].value - 116444736000000000) // 10000
    finally:
        kernel.CloseHandle(process)

def observe(local_client=None):
    state = 2 if local_client is None else 5  # LISTEN, ESTABLISHED
    matched = []
    for status, address, local, remote, other, owner in rows(socket.AF_INET, struct.Struct("<6I")):
        if status == state and socket.ntohs(local & 65535) == port and (
                local_client is None or remote == loopback and socket.ntohs(other & 65535) == local_client):
            matched.append((address, owner))
    if local_client is None:
        for _, _, local, _, _, _, status, _ in rows(socket.AF_INET6, struct.Struct("<16s2I16s4I")):
            if status == state and socket.ntohs(local & 65535) == port:
                raise ValueError("The debug port also has an IPv6 listener")
    if matched != [(loopback, pid)]:
        raise ValueError("The port does not belong to the reviewed IPv4 loopback JVM")
    return observed_start()

started = observe()
runtime = fingerprint()
if mode == "relay" and expected != {"jdkSha256": runtime, "startedAt": started}:
    raise ValueError("The remote JVM or JDK changed after review")

with tempfile.TemporaryDirectory(prefix="rb-ssh-jdwp-") as owned:
    source = pathlib.Path(owned) / "RocketbrainSshJvm.java"
    source.write_text(probe_source, encoding="utf-8")
    result = subprocess.run([str(java), "--add-modules", "jdk.attach", str(source), str(pid), str(port), str(root)],
                            cwd=owned, env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=14, check=True)
    if int(result.stdout.strip()) != started or observe() != started or fingerprint() != runtime:
        raise ValueError("The remote listener or JDK changed during verification")

if mode == "inspect":
    print(json.dumps({"pid": pid, "port": port, "startedAt": started, "jdkSha256": runtime}), flush=True)
    sys.exit(0)

sys.stdout.buffer.write(b"ROCKETBRAIN_JDWP_PREPARED\n")
sys.stdout.buffer.flush()
if os.read(sys.stdin.fileno(), 1) != b"1":
    sys.exit(0)
if observe() != started:
    raise ValueError("The reviewed listener changed before opening the socket")
with socket.create_connection(("127.0.0.1", port), timeout=4) as target:
    if observe(target.getsockname()[1]) != started:
        raise ValueError("The established socket is not owned by the reviewed remote JVM")
    target.settimeout(None)
    sys.stdout.buffer.write(b"ROCKETBRAIN_JDWP_READY\n")
    sys.stdout.buffer.flush()

    def send_to_jvm():
        try:
            while chunk := os.read(sys.stdin.fileno(), 65536):
                target.sendall(chunk)
        except OSError:
            pass
        finally:
            try:
                target.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    threading.Thread(target=send_to_jvm, daemon=True).start()
    try:
        while chunk := target.recv(65536):
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
    except OSError:
        pass
`;

// The fixed worker must fit the Windows SSH command-line limit after encoding.
const packedProgram = "import base64, zlib\nexec(zlib.decompress(base64.b64decode('" +
  deflateSync(debugSupervisor).toString('base64') + "')))";

function debugSupervisorInvocation(config, expected) {
  return { program: packedProgram, argv: [expected ? 'relay' : 'inspect', config.root, config.javaHome,
    config.pid, config.port, expected ? { jdkSha256: expected.jdkSha256, startedAt: expected.startedAt } : null, probeJava] };
}

module.exports = { debugSupervisorInvocation };
