'use strict';

const { deflateSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { buildRuntimePrimitives } = require('./ssh-build-runtime');

const init = String.raw`
gradle.projectsEvaluated {
    rootProject.repositories {
        clear()
        maven {
            name = 'RocketbrainReviewedOfflineMirror'
            url = rootProject.uri(System.getProperty('rocketbrain.offline.repository'))
            metadataSources { mavenPom(); artifact() }
        }
    }
}
gradle.taskGraph.whenReady { graph ->
    def paths = graph.allTasks.collect { task -> task.path }
    new File(System.getProperty('rocketbrain.task.graph')).setText(paths.join('\n') + '\n', 'UTF-8')
}
`;

const worker = buildRuntimePrimitives + String.raw`
invalid_script = "Choose one standard Groovy Java project with literal name, release, dependencies and Maven Central."
blocked_layout = "This Gradle build uses a composite, alternate DSL or project configuration outside the reviewed files."
coordinate = r"[A-Za-z0-9][A-Za-z0-9_.-]{0,62}"
task_names = ("test", "build")

class Tokens:
    pattern = re.compile(r'\s+|//[^\n]*|/\*[\s\S]*?\*/|[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[{}.=();]|'
                         r"""(?:'[A-Za-z0-9_.:-]{1,190}'|"[A-Za-z0-9_.:-]{1,190}")""")
    def __init__(self, data):
        text = data.decode("utf-8-sig")
        parsed = []
        offset = 0
        while offset < len(text):
            match = self.pattern.match(text, offset)
            if not match or len(parsed) >= 768:
                raise Refused(invalid_script)
            token = match.group()
            if not token[0].isspace() and not token.startswith(("//", "/*")):
                parsed.append(token)
            offset = match.end()
        self.tokens = list(reversed(parsed))

    def take(self, *allowed):
        if not self.tokens or (allowed and self.tokens[-1] not in allowed):
            raise Refused(invalid_script)
        return self.tokens.pop()

    def next(self):
        return self.tokens[-1] if self.tokens else None

    def expect(self, *tokens):
        for token in tokens:
            self.take(token)

    def punctuation(self):
        if self.next() == ";":
            self.take(";")

    def literal(self):
        value = self.take()
        if value[0] not in ("'", '"'):
            raise Refused(invalid_script)
        return value[1:-1]

    def argument(self):
        if self.next() != "(":
            return self.literal()
        self.take("(")
        value = self.literal()
        self.take(")")
        return value

def inspect_sources(build, settings):
    label = Tokens(settings)
    label.expect("rootProject", ".", "name", "=")
    project = label.literal()
    label.punctuation()
    if label.next() or not re.fullmatch(coordinate, project):
        raise Refused(invalid_script)

    script = Tokens(build)
    seen = set()
    version = None
    dependencies = []
    while script.next():
        key = script.take("plugins", "repositories", "dependencies", "group", "version", "java", "test")
        if key in seen or (not seen and key != "plugins"):
            raise Refused(invalid_script)
        seen.add(key)
        if key in ("group", "version"):
            if script.next() == "=":
                script.take("=")
            literal = script.literal()
            if not re.fullmatch(coordinate, literal) or literal.lower().endswith("-snapshot"):
                raise Refused(invalid_script)
            if key == "version":
                version = literal
        else:
            script.take("{")
            if key == "plugins":
                script.take("id")
                if script.argument() != "java":
                    raise Refused(invalid_script)
            elif key == "repositories":
                script.expect("mavenCentral", "(", ")")
            elif key == "dependencies":
                while script.next() != "}":
                    scope = script.take("implementation", "compileOnly", "runtimeOnly", "testImplementation", "testRuntimeOnly")
                    dependency = script.argument()
                    parts = dependency.split(":")
                    if len(dependencies) >= 32 or len(parts) != 3 or not all(re.fullmatch(coordinate, part) for part in parts) or parts[2].lower().endswith("-snapshot"):
                        raise Refused(invalid_script)
                    dependencies.append((scope, dependency))
                    script.punctuation()
            elif key == "java":
                script.expect("toolchain", "{", "languageVersion", "=", "JavaLanguageVersion", ".", "of", "(", "25", ")")
                script.punctuation()
                script.take("}")
            elif key == "test":
                script.expect("useJUnit", "(", ")")
            script.punctuation()
            script.take("}")
        script.punctuation()
    if "plugins" not in seen or dependencies and "repositories" not in seen:
        raise Refused(invalid_script)
    return project + (("-" + version) if version else "") + ".jar"

def gradle_tool(home, destination):
    identity = identify(physical(home, True))[:2]
    modules = copy_tree(child(home, ["lib"], True), destination / "lib", 1024, 192*MiB, 64*MiB)
    libs = destination / "lib"
    launchers = [file for file in libs.glob("gradle-launcher-*.jar") if re.fullmatch(r"gradle-launcher-9\.\d{1,2}\.\d{1,2}\.jar", file.name)]
    if len(launchers) != 1 or identify(physical(home, True))[:2] != identity:
        raise Refused("Choose one physical independent Gradle 9 distribution.")
    version = launchers[0].stem.removeprefix("gradle-launcher-")
    if tuple(map(int, version.split("."))) < (9, 9, 2):
        raise Refused("Choose independent Gradle 9.9.2 or a later Gradle 9 release.")
    return launchers[0], version, fingerprint([identity, modules])

def read_graph(file, task):
    text = read(file, 8192).decode("ascii").splitlines()
    allowed = {":compileJava", ":processResources", ":classes", ":compileTestJava", ":processTestResources",
               ":testClasses", ":test", ":jar", ":assemble", ":check", ":build"}
    if not text or len(set(text)) != len(text) or any(item not in allowed for item in text) or text[-1] != ":" + task:
        raise Refused("The Gradle task graph escaped the ordinary Java build scope.")
    return text

def gradle_reports(project):
    totals = {name: 0 for name in ("tests", "failures", "errors", "skipped", "reports")}
    directory = project / "build" / "test-results" / "test"
    if not os.path.lexists(directory):
        return totals
    physical(directory, True)
    invalid = "The Gradle test reports are invalid or exceed their limits."
    with os.scandir(directory) as entries:
        for index, entry in enumerate(entries, 1):
            if index > 384:
                raise Refused(invalid)
            if not re.fullmatch(r"TEST-[A-Za-z0-9_.$+-]+\.xml", entry.name):
                continue
            report = safe_xml(read(pathlib.Path(entry.path), MiB), invalid)
            if report.tag != "testsuite" or totals["reports"] >= 128:
                raise Refused(invalid)
            for key in ("tests", "failures", "errors", "skipped"):
                value = report.get(key)
                if not re.fullmatch(r"\d{1,6}", value or ""):
                    raise Refused(invalid)
                totals[key] += int(value)
            totals["reports"] += 1
    if totals["tests"] > 100000 or sum(totals[key] for key in ("failures", "errors", "skipped")) > totals["tests"]:
        raise Refused(invalid)
    return totals

def linux_build_scope():
    if sys.platform != "linux":
        return None
    import ctypes
    children = pathlib.Path("/proc/thread-self/children")
    message = "The Linux SSH host cannot isolate and reap Gradle child processes."
    if not children.is_file() or not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise Refused(message)
    try:
        os.close(os.pidfd_open(os.getpid()))
    except OSError:
        raise Refused(message)
    set_child_subreaper = 36
    if ctypes.CDLL(None).prctl(set_child_subreaper, 1, 0, 0, 0) != 0:
        raise Refused(message)
    return children

def reap_gradle_children(children):
    # Linux reparents detached Gradle workers to this dedicated worker after their parent exits.
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid:
            continue
        with children.open("r", encoding="ascii") as scope:
            members = scope.read(4097)
        if len(members) > 4096:
            raise Refused("The remote Gradle build exceeded its child process limit.")
        for pid in members.split():
            try:
                endpoint = os.pidfd_open(int(pid))
                try:
                    signal.pidfd_send_signal(endpoint, signal.SIGKILL)
                finally:
                    os.close(endpoint)
            except ProcessLookupError:
                continue
        time.sleep(.03)
    raise Refused("The remote Gradle child processes did not stop within the cleanup limit.")

def execute_gradle(task, jdk, launcher, cache, staged, temp, jar, cancelled):
    isolated = temp / "home"
    isolated.mkdir()
    graph = temp / "task-graph.txt"
    init_file = temp / "reviewed.gradle"
    init_file.write_text(INIT, encoding="ascii")
    env = {key: os.environ[key] for key in ("SystemRoot", "WINDIR") if key in os.environ}
    env.update(HOME=str(isolated), USERPROFILE=str(isolated), JAVA_HOME=str(jdk), TMPDIR=str(temp), TMP=str(temp), TEMP=str(temp),
        PATH=os.pathsep.join([str(jdk / "bin"), str(pathlib.Path(env.get("SystemRoot", r"C:\Windows")) / "System32") if os.name == "nt" else "/usr/bin:/bin"]))
    java = child(jdk, ["bin", "java.exe" if os.name == "nt" else "java"])
    argv = [str(java), "-Xmx512m", "-XX:-UsePerfData", "-Duser.home="+str(isolated), "-Djava.io.tmpdir="+str(temp),
        "-Dorg.gradle.java.home="+str(jdk), "-cp", str(launcher), "org.gradle.launcher.GradleMain", "--offline", "--no-daemon",
        "--no-configuration-cache", "--no-build-cache", "--no-watch-fs", "--console=plain", "--max-workers=2",
        "--gradle-user-home", str(isolated), "--project-dir", str(staged), "--init-script", str(init_file),
        "-Drocketbrain.offline.repository="+str(cache), "-Drocketbrain.task.graph="+str(graph),
        "-Dorg.gradle.java.installations.auto-download=false", "-Dorg.gradle.java.installations.auto-detect=false",
        "-Dorg.gradle.java.installations.paths="+str(jdk), "-Dorg.gradle.jvmargs=-Xmx512m", ":"+task]
    children = linux_build_scope()
    process = subprocess.Popen(argv, cwd=staged, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, start_new_session=os.name != "nt")
    try:
        deadline = time.monotonic() + 130
        while process.poll() is None:
            if cancelled.wait(.05):
                return {"state": "cancelled"}
            if time.monotonic() >= deadline:
                raise Refused("The reviewed remote Gradle build timed out.")
        code = process.returncode if 0 <= process.returncode <= 255 else 1
    finally:
        try:
            stop_process(process, env)
        finally:
            if children is not None:
                reap_gradle_children(children)
    result = {"state": "succeeded" if code == 0 else "failed", "task": task, "exitCode": code, "tests": gradle_reports(staged),
              "taskGraph": read_graph(graph, task) if os.path.lexists(graph) or code == 0 else []}
    if task == "build" and code == 0:
        item = child(staged, ["build", "libs", jar])
        data = read(item, 64*MiB)
        if data[:4] != b"PK\x03\x04":
            raise Refused("Gradle did not produce the reviewed Java JAR artifact.")
        result["artifact"] = {"name": jar, "sha256": digest(data), "size": len(data)}
    return result

def operation(request):
    root, jdk, tools, repository = [pathlib.Path(request[key]) for key in ("root", "javaHome", "gradleHome", "repository")]
    for item in (root, jdk, tools, repository):
        physical(item, True)
    parts, task, mode = segments(request["file"]), request["task"], request["mode"]
    if parts[-1] != "build.gradle" or task not in task_names:
        raise Refused(invalid_script)
    project = child(root, parts[:-1], True)
    for parent in (project, *project.parents):
        if parent != root and root not in parent.parents:
            break
        files = ("gradle.properties", "buildSrc", "build-logic", "gradle.lockfile", "settings.gradle.kts",
            "gradle/libs.versions.toml", "gradle/verification-metadata.xml", "gradle/gradle-daemon-jvm.properties", "gradle/dependency-locks")
        if any(os.path.lexists(parent / item) for item in files):
            raise Refused(blocked_layout)
        if parent != project and any(os.path.lexists(parent / item) for item in ("settings.gradle", "build.gradle", "build.gradle.kts")):
            raise Refused(blocked_layout)
    if os.path.lexists(project / "build.gradle.kts"):
        raise Refused(blocked_layout)

    identity = [identify(physical(item, True))[:2] for item in (root, project)]
    build, settings = [child(project, [leaf]) for leaf in ("build.gradle", "settings.gradle")]
    build_bytes, settings_bytes = [read(item, 128*1024) for item in (build, settings)]
    jar = inspect_sources(build_bytes, settings_bytes)
    cancelled = threading.Event()
    if mode == "run":
        def wait_for_cancellation():
            os.read(sys.stdin.fileno(), 1)
            cancelled.set()
        threading.Thread(target=wait_for_cancellation, daemon=True).start()
        if sys.platform == "linux":
            def cancel_on_disconnect(signum, frame):
                cancelled.set()
            signal.signal(signal.SIGHUP, cancel_on_disconnect)
            signal.signal(signal.SIGTERM, cancel_on_disconnect)

    with tempfile.TemporaryDirectory(prefix="rb-ssh-gradle-") as folder:
        temp = pathlib.Path(folder).resolve(strict=True)
        if any(temp == owner or owner in temp.parents for owner in (root, jdk, tools, repository)):
            raise Refused("Gradle requires scratch storage outside the reviewed SSH workspace and runtimes.")
        staged, dist, cache = temp / "project", temp / "gradle", temp / "repository"
        staged.mkdir()
        (staged / "build.gradle").write_bytes(build_bytes)
        (staged / "settings.gradle").write_bytes(settings_bytes)
        sources = copy_tree(child(project, ["src"], True), staged / "src", 512, 16*MiB, 2*MiB)
        launcher, version, tool_hash = gradle_tool(tools, dist)
        dependencies = copy_tree(repository, cache, 4000, 192*MiB, 64*MiB, cache_name)
        _, jdk_hash = compiler(jdk)
        if read(build, 128*1024) != build_bytes or read(settings, 128*1024) != settings_bytes or [identify(physical(item, True))[:2] for item in (root, project)] != identity:
            raise Refused("The reviewed Gradle project changed while it was read.")

        proof = {"descriptorSha256": digest(build_bytes), "settingsSha256": digest(settings_bytes),
                 "projectSha256": fingerprint([identity, digest(build_bytes), digest(settings_bytes), sources]),
                 "toolSha256": tool_hash, "jdkSha256": jdk_hash, "repositorySha256": fingerprint(dependencies)}
        if mode == "inspect":
            return {**proof, "task": task, "project": "/" + "/".join(parts[:-1]), "gradleVersion": version,
                    "sourceFiles": len(sources[1]), "repositoryFiles": len(dependencies[1])}
        if mode != "run" or request["expected"] != proof:
            raise Refused("The reviewed Gradle project, tool, JDK or offline repository changed after review.")
        if cancelled.is_set():
            return {"state": "cancelled"}
        result = execute_gradle(task, jdk, launcher, cache, staged, temp, jar, cancelled)
        if not cancelled.is_set() and compiler(jdk)[1] != jdk_hash:
            raise Refused("The reviewed JDK changed during the remote Gradle build.")
        return result

try:
    frame = sys.stdin.buffer.readline(8193)
    if len(frame) > 8192 or not frame.endswith(b"\n"):
        raise Refused("The remote Gradle request exceeds its input limit.")
    result = operation(json.loads(frame))
except Refused as error:
    result = {"error": str(error)}
except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
    result = {"error": "Verify the physical remote Gradle project, independent runtimes and prepared offline repository."}
print(json.dumps(result, ensure_ascii=True), flush=True)
`;

const payload = deflateSync('INIT=' + JSON.stringify(init) + '\n' + worker, { level: 9 }).toString('base64');
const payloadDigest = createHash('sha256').update(payload).digest('hex');
const gradleProgram = "import base64, hashlib, sys, zlib\n" +
  "frame=sys.stdin.buffer.readline(12289)\n" +
  "if not frame.endswith(b'\\n') or hashlib.sha256(frame[:-1]).hexdigest()!='" + payloadDigest + "':\n" +
  "    raise ValueError('Unverified Gradle worker source')\n" +
  "exec(zlib.decompress(base64.b64decode(frame[:-1], validate=True)))";

function gradleRequest(config, expected) {
  const body = JSON.stringify({ ...config, mode: expected ? 'run' : 'inspect', expected }) + '\n';
  if (Buffer.byteLength(body) > 8192 || payload.length >= 12289) throw Error('The SSH Gradle request exceeds its input limit.');
  return payload + '\n' + body;
}

module.exports = { gradleProgram, gradleRequest };
