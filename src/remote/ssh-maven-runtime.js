'use strict';

const { deflateSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { javaRuntimePrimitives } = require('./ssh-java-compile-runtime');

const worker = javaRuntimePrimitives + String.raw`
import signal, time, xml.etree.ElementTree as etree

MiB = 1048576
part = r"[A-Za-z0-9_$ .+-]{1,180}"
coordinate = r"[A-Za-z0-9][A-Za-z0-9_.-]{0,89}"
maven_ns = "{http://maven.apache.org/POM/4.0.0}"
def name(x):
    return x.tag.removeprefix(maven_ns)

def safe_xml(raw, error):
    text = raw.decode("utf-8-sig")
    if re.search(r"<!DOCTYPE|<!ENTITY", text, re.I):
        raise Refused(error)
    try:
        return etree.fromstring(text)
    except etree.ParseError:
        raise Refused(error)

def project_descriptor(raw):
    message = "Choose one literal Maven JAR POM with conventional sources, dependencies and lifecycle plugins."
    model = safe_xml(raw, message)
    if name(model) != "project":
        raise Refused(message)
    schema = {
        "project": "modelVersion groupId artifactId version packaging name description properties dependencies build",
        "properties": "maven.compiler.release maven.compiler.source maven.compiler.target project.build.sourceEncoding",
        "dependencies": "dependency",
        "dependency": "groupId artifactId version scope type optional classifier exclusions",
        "exclusions": "exclusion", "exclusion": "groupId artifactId",
        "build": "plugins", "plugins": "plugin", "plugin": "groupId artifactId version"
    }
    def fields(node):
        label = name(node)
        allowed = schema.get(label, "").split()
        tags = [name(item) for item in node]
        allowed_attrs = {"{http://www.w3.org/2001/XMLSchema-instance}schemaLocation"} if label == "project" else set()
        if (not set(node.attrib).issubset(allowed_attrs) or any(tag not in allowed for tag in tags) or
            (allowed and (node.text or "").strip()) or
            (label not in ("dependencies", "plugins", "exclusions") and len(set(tags)) != len(tags)) or
            any((item.tail or "").strip() for item in node)):
            raise Refused(message)
        if not allowed and (chr(36) + "{" in (node.text or "") or not (node.text or "").strip()):
            raise Refused(message)
        for item in node:
            fields(item)
    def value(node, key, default=None):
        return next(((item.text or "").strip() for item in node if name(item) == key), default)
    fields(model)
    artifact, version = value(model, "artifactId"), value(model, "version")
    if (value(model, "modelVersion") != "4.0.0" or value(model, "packaging", "jar") != "jar" or
        not all(isinstance(item, str) and re.fullmatch(coordinate, item) for item in
                (value(model, "groupId"), artifact, version))):
        raise Refused(message)
    for item in model.iter():
        label = name(item)
        if label in ("plugin", "dependency", "exclusion"):
            key = value(item, "artifactId")
            group = value(item, "groupId", "org.apache.maven.plugins" if label == "plugin" else None)
            pins = (group, key) if label == "exclusion" else (group, key, value(item, "version"))
            if not all(isinstance(pin, str) and re.fullmatch(coordinate, pin) for pin in pins):
                raise Refused(message)
            if label == "plugin" and (group != "org.apache.maven.plugins" or key not in
                ("maven-compiler-plugin", "maven-surefire-plugin", "maven-resources-plugin", "maven-jar-plugin")):
                raise Refused(message)
            if label == "dependency" and (value(item, "scope", "compile") not in ("compile", "test", "runtime", "provided") or
                value(item, "type", "jar") != "jar" or not re.fullmatch(coordinate, value(item, "classifier", "default"))):
                raise Refused(message)
    return artifact + "-" + version + ".jar"

def inventory(root, maximum):
    files, total, pending = [], 0, [(root, (), 0)]
    while pending:
        current, prefix, depth = pending.pop()
        physical(current, True)
        if depth > 24:
            raise Refused("A reviewed Maven directory is too deeply nested.")
        with os.scandir(current) as entries:
            for entry in entries:
                total += 1
                if total > maximum or not re.fullmatch(part, entry.name) or entry.name.lower() in (".git", ".mvn") or entry.name.endswith((" ", ".")):
                    raise Refused("A reviewed Maven directory exceeds its entry limit or has an unsupported name.")
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
        raise Refused("The selected Maven source, tool or repository exceeds its file budget.")
    report = []
    size = 0
    destination.mkdir(parents=True, exist_ok=True)
    for relative, identity in files:
        if allowed and not allowed(relative):
            raise Refused("Select a dedicated Maven repository containing only ordinary cached Maven files.")
        item = child(origin, relative.split("/"))
        if identity != identify(physical(item)):
            raise Refused("The reviewed Maven directory changed while it was read.")
        data = read(item, per_file)
        size += len(data)
        if size > budget:
            raise Refused("The selected Maven source, tool or repository exceeds its byte budget.")
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as output:
            output.write(data)
        report.append([relative, digest(data), len(data)])
    if identify(physical(origin, True))[:2] != root or inventory(origin, max_files * 3 + 128) != files:
        raise Refused("The reviewed Maven directory changed while it was read.")
    return [root, report]

def fingerprint(value):
    return digest(json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode())

def maven_tool(home, destination):
    identity = identify(physical(home, True))[:2]
    data = [copy_tree(child(home, [name], True), destination / name, 256, 64*MiB, 32*MiB) for name in ("boot", "lib")]
    data.append(copy_tree(child(home, ["conf", "logging"], True), destination / "conf" / "logging", 8, MiB, MiB))
    config = read(child(home, ["bin", "m2.conf"]), 64 * 1024)
    (destination / "bin").mkdir()
    (destination / "bin" / "m2.conf").write_bytes(config)
    launchers = list((destination / "boot").glob("plexus-classworlds-*.jar"))
    if len(launchers) != 1 or len(list((destination / "lib").glob("maven-core-3.9.*.jar"))) != 1:
        raise Refused("Choose one independent Apache Maven 3.9 distribution with its packaged launcher.")
    if identify(physical(home, True))[:2] != identity:
        raise Refused("The reviewed Maven distribution changed while it was read.")
    return launchers[0], fingerprint([identity, data, digest(config)])

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

def suite_result(project):
    totals = {name: 0 for name in ("tests", "failures", "errors", "skipped", "reports")}
    target = project / "target"
    reports = target / "surefire-reports"
    if not os.path.lexists(reports):
        return totals
    failed = "The Maven Surefire reports are invalid or exceed their limits."
    physical(reports, True)
    with os.scandir(reports) as directory:
        for count, entry in enumerate(directory, 1):
            if count > 384:
                raise Refused(failed)
            if not re.fullmatch(r"TEST-[A-Za-z0-9_.$+-]+\.xml", entry.name):
                continue
            report = safe_xml(read(pathlib.Path(entry.path), MiB), failed)
            if report.tag != "testsuite" or totals["reports"] >= 128:
                raise Refused(failed)
            for key in ("tests", "failures", "errors", "skipped"):
                field = report.get(key)
                if not field or not re.fullmatch(r"[0-9]{1,6}", field):
                    raise Refused(failed)
                totals[key] += int(field)
            totals["reports"] += 1
    if totals["tests"] > 100000 or sum(totals[key] for key in ("failures", "errors", "skipped")) > totals["tests"]:
        raise Refused(failed)
    return totals

def execute_maven(task, jdk, tools, launcher, cache, project, temp, jar, cancelled):
    env = {key: os.environ[key] for key in ("SystemRoot", "WINDIR") if key in os.environ}
    isolated = temp / "home"
    isolated.mkdir()
    env.update(HOME=str(isolated), USERPROFILE=str(isolated), JAVA_HOME=str(jdk), TMPDIR=str(temp), TMP=str(temp), TEMP=str(temp),
        PATH=os.pathsep.join([str(jdk / "bin"), str(pathlib.Path(env.get("SystemRoot", r"C:\Windows")) / "System32") if os.name == "nt" else "/usr/bin:/bin"]))
    settings = temp / "settings.xml"
    settings.write_text("<settings/>", encoding="ascii")
    java = child(jdk, ["bin", "java.exe" if os.name == "nt" else "java"])
    argv = [str(java), "-Xmx768m", "-XX:-UsePerfData", "-Duser.home="+str(isolated), "-Djava.io.tmpdir="+str(temp),
        "-Dmaven.home="+str(tools), "-Dmaven.multiModuleProjectDirectory="+str(project),
        "-Dclassworlds.conf="+str(tools / "bin" / "m2.conf"), "-cp", str(launcher),
        "org.codehaus.plexus.classworlds.launcher.Launcher", "--offline", "--batch-mode", "--non-recursive", "--no-transfer-progress",
        "--settings", str(settings), "--global-settings", str(settings), "-Dmaven.repo.local="+str(cache),
        "-Dstyle.color=never", "-DforkCount=0", task]
    process = subprocess.Popen(argv, cwd=project, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, start_new_session=os.name != "nt")
    try:
        deadline = time.monotonic() + 90
        while process.poll() is None:
            if cancelled.wait(.05):
                return {"state": "cancelled"}
            if time.monotonic() >= deadline:
                raise Refused("The reviewed remote Maven build timed out.")
        code = process.returncode if 0 <= process.returncode <= 255 else 1
    finally:
        stop_process(process, env)
    result = {"state": "succeeded" if code == 0 else "failed", "task": task, "exitCode": code, "tests": suite_result(project)}
    if task == "package" and code == 0:
        artifact = child(project, ["target", jar])
        data = read(artifact, 64*MiB)
        if data[:4] != b"PK\x03\x04":
            raise Refused("Maven did not produce the expected ordinary JAR artifact.")
        result["artifact"] = {"name": jar, "sha256": digest(data), "size": len(data)}
    return result

def operation(request):
    root, jdk, home, repository = [pathlib.Path(request[key]) for key in ("root", "javaHome", "mavenHome", "repository")]
    for item in (root, jdk, home, repository):
        physical(item, True)
    parts = segments(request["file"])
    task, mode = request["task"], request["mode"]
    if parts[-1] != "pom.xml" or task not in ("test", "package") or ".mvn" in [part.lower() for part in parts]:
        raise Refused("Choose one physical Maven pom.xml and the standard test or package task.")
    project = child(root, parts[:-1], True)
    for parent in (project, *project.parents):
        if parent != root and root not in parent.parents:
            break
        if any(os.path.lexists(parent / name) for name in (".mvn", "mvnw", "mvnw.cmd")):
            raise Refused("Use independent Maven without a project wrapper or .mvn overrides.")
    identity = [identify(physical(item, True))[:2] for item in (root, project)]
    descriptor = child(project, ["pom.xml"])
    pom = read(descriptor, 256*1024)
    jar = project_descriptor(pom)
    cancelled = threading.Event()
    if mode == "run":
        def wait_for_cancellation():
            os.read(sys.stdin.fileno(), 1)
            cancelled.set()
        threading.Thread(target=wait_for_cancellation, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix="rb-ssh-maven-") as folder:
        temp = pathlib.Path(folder).resolve(strict=True)
        if any(temp == owner or owner in temp.parents for owner in (root, home, repository, jdk)):
            raise Refused("Maven requires storage outside the reviewed SSH workspace and runtimes.")
        staged, tools, cache = temp / "project", temp / "maven", temp / "repository"
        staged.mkdir()
        (staged / "pom.xml").write_bytes(pom)
        sources = copy_tree(child(project, ["src"], True), staged / "src", 512, 16*MiB, 2*MiB)
        launcher, tool_hash = maven_tool(home, tools)
        dependencies = copy_tree(repository, cache, 4000, 192*MiB, 64*MiB, cache_name)
        _, jdk_hash = compiler(jdk)
        if not dependencies[1] or read(descriptor, 256*1024) != pom or [identify(physical(item, True))[:2] for item in (root, project)] != identity:
            raise Refused("The reviewed Maven descriptor or repository is missing or changed.")
        proof = {"descriptorSha256": digest(pom), "projectSha256": fingerprint([identity, digest(pom), sources]),
                 "toolSha256": tool_hash, "jdkSha256": jdk_hash, "repositorySha256": fingerprint(dependencies)}
        if mode == "inspect":
            return {**proof, "task": task, "project": "/" + "/".join(parts[:-1]),
                    "sourceFiles": len(sources[1]), "repositoryFiles": len(dependencies[1])}
        if mode != "run" or request["expected"] != proof:
            raise Refused("The reviewed Maven project, tool, JDK or offline repository changed after review.")
        if cancelled.is_set():
            return {"state": "cancelled"}
        result = execute_maven(task, jdk, tools, launcher, cache, staged, temp, jar, cancelled)
        if not cancelled.is_set() and compiler(jdk)[1] != jdk_hash:
            raise Refused("The reviewed JDK changed during the remote Maven build.")
        return result

try:
    frame = sys.stdin.buffer.readline(8193)
    if len(frame) > 8192 or not frame.endswith(b"\n"):
        raise Refused("The remote Maven request exceeds its input limit.")
    result = operation(json.loads(frame))
except Refused as error:
    result = {"error": str(error)}
except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
    result = {"error": "Verify the physical remote Maven project, independent runtimes and prepared offline repository."}
print(json.dumps(result, ensure_ascii=True), flush=True)
`;

const payload = deflateSync(worker, { level: 9 }).toString('base64');
const payloadDigest = createHash('sha256').update(payload).digest('hex');
const mavenProgram = "import base64, hashlib, sys, zlib\n" +
  "frame=sys.stdin.buffer.readline(12289)\n" +
  "if not frame.endswith(b'\\n') or hashlib.sha256(frame[:-1]).hexdigest()!='" + payloadDigest + "':\n" +
  "    raise ValueError('Unverified Maven worker source')\n" +
  "exec(zlib.decompress(base64.b64decode(frame[:-1], validate=True)))";

function mavenRequest(config, expected) {
  const body = JSON.stringify({ ...config, mode: expected ? 'run' : 'inspect', expected }) + '\n';
  if (Buffer.byteLength(body) > 8192 || payload.length >= 12289) throw Error('The SSH Maven request exceeds its input limit.');
  return payload + '\n' + body;
}

module.exports = { mavenProgram, mavenRequest };
