'use strict';

const { deflateSync } = require('node:zlib');

const worker = String.raw`import hashlib, json, os, pathlib, re, stat, subprocess, sys, tempfile, threading, zipfile

class Refused(ValueError):
    pass

def digest(data):
    return hashlib.sha256(data).hexdigest()

def identify(info):
    values = [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns]
    return values if sys.platform == "win32" else values + [info.st_ctime_ns]

def physical(item, directory=False):
    if not item.is_absolute() or item.resolve(strict=True) != item:
        raise Refused("Use physical workspace files without links.")
    info = item.lstat()
    if getattr(info, "st_file_attributes", 0) & 1024 or (
        not stat.S_ISDIR(info.st_mode) if directory else not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
    ):
        raise Refused("Use regular workspace files and directories without links.")
    return info

def segments(value):
    if not isinstance(value, str) or re.fullmatch(r"/[A-Za-z0-9_$ .+-]+(?:/[A-Za-z0-9_$ .+-]+){0,23}", value) is None:
        raise Refused("Use workspace-relative Java or JAR paths.")
    parts = value[1:].split("/")
    if any(part in (".", "..") or part.lower() == ".git" or part.endswith((" ", ".")) or len(part) > 128 for part in parts):
        raise Refused("Use workspace-relative Java or JAR paths.")
    return parts

def child(root, parts, directory=False):
    current = root
    for index, part in enumerate(parts, 1):
        current = current / part
        physical(current, directory or index != len(parts))
    return current

def read(item, limit):
    before = identify(physical(item))
    with item.open("rb") as stream:
        if identify(os.fstat(stream.fileno())) != before:
            raise Refused("A reviewed file changed while it was read.")
        data = stream.read(limit + 1)
        if len(data) > limit:
            raise Refused("A reviewed file exceeds the compile limit.")
        if identify(os.fstat(stream.fileno())) != before or identify(physical(item)) != before:
            raise Refused("A reviewed file changed while it was read.")
    return data

def compiler(home):
    windows = sys.platform == "win32"
    paths = ["release", "lib/modules", "lib/ct.sym", "lib/jvm.cfg"]
    paths += ["bin/java.exe", "bin/javac.exe", "bin/jli.dll", "bin/java.dll", "bin/server/jvm.dll"] if windows else [
        "bin/java", "bin/javac", "lib/libjli.so", "lib/libjava.so", "lib/server/libjvm.so"]
    fingerprint = hashlib.sha256()
    for key in paths:
        item = child(home, key.split("/"))
        before = identify(physical(item))
        if before[2] > 300 * 1048576:
            raise Refused("The remote JDK file exceeds the compile limit.")
        fingerprint.update(key.encode("utf8") + b"\0")
        with item.open("rb") as stream:
            if identify(os.fstat(stream.fileno())) != before:
                raise Refused("The remote JDK changed while it was read.")
            while data := stream.read(1048576):
                fingerprint.update(data)
            if identify(os.fstat(stream.fileno())) != before or identify(physical(item)) != before:
                raise Refused("The remote JDK changed while it was read.")
    release = read(home / "release", 16384).decode("utf8")
    if "jetbrains" in release.lower() or not re.search(r'^JAVA_VERSION="25(?:\.|")', release, re.M):
        raise Refused("Choose an independent JDK 25 directory.")
    return home / "bin" / ("javac.exe" if windows else "javac"), fingerprint.hexdigest()

def source_tree(directory):
    count = 0
    pending = [(directory, ())]
    while pending:
        current, prefix = pending.pop()
        if len(prefix) > 16:
            raise Refused("The module source folders are too deeply nested.")
        with os.scandir(current) as entries:
            for entry in entries:
                count += 1
                if count > 1500:
                    raise Refused("The module source tree exceeds the compile limit.")
                if entry.is_symlink():
                    raise Refused("The module source tree contains a link.")
                relative = (*prefix, entry.name)
                item = pathlib.Path(entry.path)
                if entry.is_dir(follow_symlinks=False):
                    physical(item, True)
                    if re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", entry.name) is None:
                        raise Refused("Use ASCII Java package paths in the reviewed module.")
                    pending.append((item, relative))
                elif entry.name.endswith(".java"):
                    if re.fullmatch(r"(?:[A-Za-z_$][A-Za-z0-9_$]*|package-info|module-info)\.java", entry.name) is None:
                        raise Refused("Use ASCII Java source file names in the reviewed module.")
                    yield "/".join(relative)

def keep_jar(file):
    with zipfile.ZipFile(file) as archive:
        entries = archive.infolist()
        if len(entries) > 20000 or sum(entry.file_size for entry in entries) > 192 * 1048576:
            raise Refused("A dependency JAR exceeds the compile limit.")
        manifests = [entry for entry in entries if entry.filename.upper() == "META-INF/MANIFEST.MF"]
        if len(manifests) > 1 or manifests and manifests[0].file_size > 65536:
            raise Refused("A dependency JAR has an unsupported manifest.")
        if manifests and re.search(br"(?im)(?:^|\r)class-path[ \t]*:", archive.read(manifests[0])):
            raise Refused("Choose a dependency JAR without an external manifest Class-Path.")

def snapshot(root, source_parts, selected, jars, temp):
    directory = child(root, source_parts, True)
    root_identity = identify(physical(root, True))[:2]
    module_identity = identify(physical(directory, True))[:2]
    sources = []
    source_bytes = 0
    for relative in sorted(source_tree(directory)):
        if len(sources) >= 128:
            raise Refused("Choose a module of at most 128 Java sources.")
        item = child(directory, relative.split("/"))
        raw = read(item, 512 * 1024)
        source_bytes += len(raw)
        if source_bytes > 8 * 1048576:
            raise Refused("Choose a Java module of at most 8 MiB.")
        raw.decode("utf8")
        target = temp / "sources" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as output:
            output.write(raw)
        sources.append([relative, digest(raw), len(raw)])
    selected_sha = next((row[1] for row in sources if row[0] == selected), None)
    if not selected_sha:
        raise Refused("Choose a saved Java file in the reviewed module.")
    if sorted(source_tree(directory)) != [row[0] for row in sources]:
        raise Refused("The module source list changed while it was read.")
    jars_directory = temp / "libraries"
    jars_directory.mkdir()
    dependencies = []
    jar_bytes = 0
    for index, virtual in enumerate(jars):
        raw = read(child(root, segments(virtual)), 12 * 1048576)
        jar_bytes += len(raw)
        if jar_bytes > 48 * 1048576:
            raise Refused("The dependency JARs exceed 48 MiB.")
        staged = jars_directory / (str(index) + ".jar")
        staged.write_bytes(raw)
        keep_jar(staged)
        dependencies.append([virtual, digest(raw), len(raw)])
    if identify(physical(root, True))[:2] != root_identity or identify(physical(directory, True))[:2] != module_identity:
        raise Refused("The workspace root or source module changed.")
    fingerprint = digest(json.dumps([root_identity, module_identity, sources, dependencies], separators=(",", ":")).encode("utf8"))
    return sources, dependencies, selected_sha, fingerprint

def javac(binary, temp, sources, dependencies, cancelled):
    classes = temp / "classes"
    classes.mkdir()
    classpath = os.pathsep.join("libraries/" + str(index) + ".jar" for index in range(len(dependencies))) or "libraries"
    (temp / "compile.args").write_text(
        "\n".join(["-encoding", "UTF-8", "--release", "25", "-proc:none", "-implicit:none",
                   "-XDrawDiagnostics", "-Xmaxerrs", "40", "-Xmaxwarns", "40", "-classpath", classpath, "-sourcepath",
                   "sources", "-d", "classes", *["sources/" + row[0] for row in sources]]) + "\n", encoding="ascii")
    env = {key: value for key, value in os.environ.items() if key.upper() in ("SYSTEMROOT", "WINDIR")}
    env.update(TEMP=str(temp), TMP=str(temp), TMPDIR=str(temp))
    with (temp / "diagnostics").open("w+b") as output:
        child_process = subprocess.Popen([str(binary), "-J-Xmx256m", "-J-XX:-UsePerfData", "@compile.args"],
            cwd=temp, env=env, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT)
        try:
            for _ in range(600):
                if cancelled.wait(0.05):
                    return {"state": "cancelled"}
                if child_process.poll() is not None:
                    break
            else:
                raise Refused("The remote compiler timed out.")
        finally:
            if child_process.poll() is None:
                child_process.kill()
                child_process.wait(timeout=4)
        output.seek(0)
        report = output.read(16385)
    lines = []
    for line in report[:16384].decode("utf8", errors="replace").splitlines()[:80]:
        match = re.match(r"^([^:]+):(\d+):(\d+): (compiler\.(?:err|warn)\.[a-z0-9_.]+)", line)
        if match:
            leaf, number, column, code = match.groups()
            matches = [row for row in sources if row[0].rsplit("/", 1)[-1] == leaf]
            location = {"path": matches[0][0], "sha256": matches[0][1]} if len(matches) == 1 else {}
            lines.append({**location, "file": leaf, "line": int(number), "column": int(column), "code": code})
    if child_process.returncode != 0:
        return {"state": "failed", "diagnostics": lines, "truncated": len(report) > 16384}
    outputs = sorted(classes.rglob("*.class"))
    if not outputs or len(outputs) > 1024:
        raise Refused("The compiler must produce from 1 to 1,024 class files.")
    fingerprint = hashlib.sha256()
    for item in outputs:
        raw = read(item, 1024 * 1024)
        if raw[:4] != b"\xca\xfe\xba\xbe":
            raise Refused("The compiler output is not a supported class file.")
        fingerprint.update(item.relative_to(classes).as_posix().encode("utf8") + b"\0" + bytes.fromhex(digest(raw)))
    return {"state": "compiled", "classCount": len(outputs), "artifactSha256": fingerprint.hexdigest(), "diagnostics": lines,
            "classes": [item.relative_to(classes).as_posix() for item in outputs[:32]], "truncated": len(report) > 16384}

def operation(request):
    root = pathlib.Path(request["root"])
    home = pathlib.Path(request["javaHome"])
    physical(root, True)
    physical(home, True)
    chosen = segments(request["file"])
    cuts = [i for i in range(len(chosen) - 3) if chosen[i:i+3] == ["src", "main", "java"]]
    if len(cuts) != 1 or not chosen[-1].endswith(".java"):
        raise Refused("Choose a saved Java file under one src/main/java directory.")
    cut = cuts[0]
    jars = request["jars"]
    if len(jars) > 24 or len(set(jars)) != len(jars) or any(not item.endswith(".jar") for item in jars):
        raise Refused("Choose at most 24 distinct workspace dependency JARs.")
    selected = "/".join(chosen[cut+3:])
    mode = request["mode"]
    cancelled = threading.Event()
    if mode == "compile":
        def wait_for_cancellation():
            os.read(sys.stdin.fileno(), 1)
            cancelled.set()
        threading.Thread(target=wait_for_cancellation, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix="rb-ssh-compile-") as folder:
        temp = pathlib.Path(folder).resolve(strict=True)
        if root == temp or root in temp.parents:
            raise Refused("The compiler requires a temporary directory outside the remote workspace.")
        sources, libraries, file_sha, input_sha = snapshot(root, chosen[:cut+3], selected, jars, temp)
        binary, jdk = compiler(home)
        proof = {"inputSha256": input_sha, "jdkSha256": jdk, "selectedSha256": file_sha}
        if mode == "inspect":
            return {**proof, "sourceCount": len(sources), "module": "/" + "/".join(chosen[:cut])}
        if mode != "compile" or request["expected"] != proof:
            raise Refused("The remote sources, dependency JARs or JDK changed after review.")
        if cancelled.is_set():
            return {"state": "cancelled"}
        compiled = javac(binary, temp, sources, libraries, cancelled)
        if not cancelled.is_set() and compiler(home)[1] != jdk:
            raise Refused("The remote JDK changed during compilation.")
        return compiled

try:
    frame = sys.stdin.buffer.readline(8193)
    if len(frame) > 8192 or not frame.endswith(b"\n"):
        raise Refused("The remote compile request exceeds its input limit.")
    result = operation(json.loads(frame))
except Refused as error:
    result = {"error": str(error)}
except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile, subprocess.TimeoutExpired):
    result = {"error": "Verify the physical JDK, remote module, source encoding and dependency JARs."}
print(json.dumps(result, ensure_ascii=True), flush=True)
`;

const compileProgram = "import base64, zlib\nexec(zlib.decompress(base64.b64decode('" +
  deflateSync(worker, { level: 9 }).toString('base64') + "')))";

function compileRequest(config, expected) {
  const body = JSON.stringify({ ...config, mode: expected ? 'compile' : 'inspect', expected }) + '\n';
  if (Buffer.byteLength(body) > 8192) throw Error('The SSH compile request exceeds its input limit.');
  return body;
}

module.exports = { compileProgram, compileRequest };
