'use strict';

const { javaRuntimePrimitives } = require('./ssh-java-compile-runtime');

const buildRuntimePrimitives = javaRuntimePrimitives + String.raw`
import signal, time, xml.etree.ElementTree as etree

MiB = 1048576
part = r"[A-Za-z0-9_$ .+-]{1,180}"

def safe_xml(raw, error):
    text = raw.decode("utf-8-sig")
    if re.search(r"<!DOCTYPE|<!ENTITY", text, re.I):
        raise Refused(error)
    try:
        return etree.fromstring(text)
    except etree.ParseError:
        raise Refused(error)

def inventory(root, maximum):
    files, total, pending = [], 0, [(root, (), 0)]
    while pending:
        current, prefix, depth = pending.pop()
        physical(current, True)
        if depth > 24:
            raise Refused("A reviewed build directory is too deeply nested.")
        with os.scandir(current) as entries:
            for entry in entries:
                total += 1
                if total > maximum or not re.fullmatch(part, entry.name) or entry.name.lower() in (".git", ".mvn") or entry.name.endswith((" ", ".")):
                    raise Refused("A reviewed build directory exceeds its entry limit or has an unsupported name.")
                item = pathlib.Path(entry.path)
                label = (*prefix, entry.name)
                if entry.is_dir(follow_symlinks=False):
                    pending.append((item, label, depth + 1))
                else:
                    info = physical(item)
                    files.append(("/".join(label), identify(info)))
    return sorted(files)

def copy_tree(origin, destination, max_files, budget, per_file, allowed=None):
    root = identify(physical(origin, True))[:2]
    files = inventory(origin, max_files * 3 + 128)
    if len(files) > max_files:
        raise Refused("The selected build source, tool or repository exceeds its file budget.")
    report = []
    size = 0
    destination.mkdir(parents=True, exist_ok=True)
    for relative, identity in files:
        if allowed and not allowed(relative):
            raise Refused("Select a dedicated Maven repository containing only ordinary cached Maven files.")
        item = child(origin, relative.split("/"))
        if identity != identify(physical(item)):
            raise Refused("The reviewed build directory changed while it was read.")
        data = read(item, per_file)
        size += len(data)
        if size > budget:
            raise Refused("The selected build source, tool or repository exceeds its byte budget.")
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as output:
            output.write(data)
        report.append([relative, digest(data), len(data)])
    if identify(physical(origin, True))[:2] != root or inventory(origin, max_files * 3 + 128) != files:
        raise Refused("The reviewed build directory changed while it was read.")
    return [root, report]

def fingerprint(value):
    return digest(json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode())

def cache_name(relative):
    leaf = relative.rsplit("/", 1)[-1]
    return bool(re.fullmatch(r"[A-Za-z0-9_.+-]+\.(?:jar|pom|xml|properties|sha1|sha256|sha512|md5|lastUpdated)", leaf)
                or leaf == "_remote.repositories")

def stop_process(process, env):
    if process.poll() is not None:
        return
    if os.name == "nt":
        system = pathlib.Path(env.get("SystemRoot", r"C:\Windows"))
        subprocess.run([str(system / "System32" / "taskkill.exe"), "/pid", str(process.pid), "/t", "/f"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=4, env=env)
        if process.poll() is None:
            process.kill()
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    process.wait(timeout=4)

`;

module.exports = { buildRuntimePrimitives };
