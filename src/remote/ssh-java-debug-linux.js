'use strict';

const ownership = String.raw`
def proc_text(path, limit):
    with path.open("rb") as file:
        data = file.read(limit + 1)
    if len(data) > limit:
        raise ValueError("The Linux process observation exceeded its read limit")
    return data.decode("utf-8")

def linux_process():
    process = pathlib.Path("/proc") / str(pid)
    if any((process / "ns" / kind).stat().st_ino != pathlib.Path("/proc/self/ns", kind).stat().st_ino
           for kind in ("user", "pid", "net")):
        raise ValueError("The JVM belongs to a different Linux namespace")
    attributes = proc_text(process / "status", 32768)
    owners = [line.split()[1:] for line in attributes.splitlines() if line.startswith("Uid:")]
    if owners != [[str(os.geteuid())] * 4]:
        raise ValueError("The Linux JVM belongs to a different account")
    if (process / "cwd").resolve(strict=True) != root or (process / "exe").resolve(strict=True).name != "java":
        raise ValueError("The Linux JVM working directory or executable does not match the review")
    stat = proc_text(process / "stat", 32768)
    fields = stat.rpartition(")")[2].split()
    if not stat.startswith(str(pid) + " (") or len(fields) <= 19 or fields[0] in ("Z", "X", "x"):
        raise ValueError("The Linux JVM lifetime is unavailable")
    ticks = fields[19]
    if not ticks.isascii() or not ticks.isdecimal() or not 1 <= int(ticks) < 2**64:
        raise ValueError("The Linux JVM start time is unavailable")
    return process, ticks

def tcp_rows(text, width):
    lines = text.splitlines()
    if not lines or lines[0].split()[:4] not in (
            ["sl", "local_address", "rem_address", "st"], ["sl", "local_address", "remote_address", "st"]):
        raise ValueError("The Linux TCP ownership table is unrecognized")
    for line in lines[1:]:
        columns = line.split()
        if len(columns) < 10 or not columns[0].endswith(":"):
            raise ValueError("The Linux TCP ownership table is incomplete")
        local = columns[1].split(":")
        remote = columns[2].split(":")
        if any(len(endpoint) != 2 or len(endpoint[0]) != width or len(endpoint[1]) != 4
               or any(character not in "0123456789abcdefABCDEF" for part in endpoint for character in part)
               for endpoint in (local, remote)):
            raise ValueError("The Linux TCP ownership table contains an invalid address")
        yield local[0].upper(), int(local[1], 16), remote[0].upper(), int(remote[1], 16), columns[3], int(columns[7]), columns[9]

linux_loopback = "%08X" % struct.unpack("=I", socket.inet_aton("127.0.0.1"))[0]

def linux_socket(client_port):
    state = "0A" if client_port is None else "01"
    if client_port is None:
        ipv6 = proc_text(pathlib.Path("/proc/net/tcp6"), 4 * 1048576)
        if any(row[1] == port and row[4] == state for row in tcp_rows(ipv6, 32)):
            raise ValueError("The debug port also has an IPv6 listener")
    ipv4 = proc_text(pathlib.Path("/proc/net/tcp"), 4 * 1048576)
    entries = [row for row in tcp_rows(ipv4, 8) if row[1] == port and row[4] == state
               and (client_port is None or (row[2], row[3]) == (linux_loopback, client_port))]
    if not entries and client_port is not None:
        return None
    if (len(entries) != 1 or entries[0][0] != linux_loopback or entries[0][5] != os.geteuid()
            or client_port is None and entries[0][2:4] != ("00000000", 0)):
        raise ValueError("The requested Linux socket is not a unique same-account IPv4 loopback endpoint")
    inode = entries[0][6]
    if not inode.isascii() or not inode.isdecimal():
        raise ValueError("The Linux socket inode is unavailable")
    return inode if inode != "0" else None

def owns_linux_inode(process, inode):
    if inode is None:
        return False
    with os.scandir(process / "fd") as descriptors:
        for count, descriptor in enumerate(descriptors):
            if count >= 16384:
                raise ValueError("The Linux JVM has too many open descriptors to verify")
            try:
                if os.readlink(descriptor.path) == "socket:[" + inode + "]":
                    return True
            except FileNotFoundError:
                continue
    return False

def observe_linux(client_port=None):
    process, ticks = linux_process()
    # The established table row can precede accept() and publication of the JVM file descriptor.
    for attempt in range(1 if client_port is None else 16):
        inode = linux_socket(client_port)
        if owns_linux_inode(process, inode):
            if linux_process()[1] != ticks:
                raise ValueError("The Linux JVM changed while checking its socket")
            return ticks, inode
        if client_port is not None:
            time.sleep(0.025)
    raise ValueError("The selected Linux JVM does not hold the socket inode")
`;

module.exports = { ownership };
