'use strict';

const { spawn } = require('node:child_process');
const { jdtLaunchArguments } = require('../java/runtime');
const { pathSegments } = require('./java-mapping');

const supervisor = `import hashlib, json, os, pathlib, platform, re, shutil, subprocess, sys, tempfile, threading

def physical(value):
    item = pathlib.Path(value)
    if item.resolve(strict=True) != item:
        raise ValueError("Use physical Java and workspace paths")
    return item

def fingerprint(files):
    digest = hashlib.sha256()
    for item in files:
        if item.resolve(strict=True) != item or not item.is_file() or item.stat().st_size > 67108864:
            raise ValueError("Invalid JDT runtime file")
        digest.update((str(item) + "\\x00").encode())
        with item.open("rb") as stream:
            for chunk in iter(lambda: stream.read(65536), b""):
                digest.update(chunk)
    return digest.hexdigest()

mode, java_home, jdt, workspace, expected, encoded = sys.argv[1:]
if sys.platform != "linux":
    raise ValueError("Use a Linux Dev Container")
java, server, project = (physical(value) for value in (java_home, jdt, workspace))
release = java / "release"
if release.stat().st_size > 65536:
    raise ValueError("Invalid Java release")
release_text = release.read_text(encoding="utf8")
version = re.search(r'(?m)^JAVA_VERSION="([0-9]+)', release_text)
if not version or int(version.group(1)) < 25 or "jetbrains" in release_text.lower():
    raise ValueError("Use an independent JDK 25 or later")
launcher, = sorted((server / "plugins").glob("org.eclipse.equinox.launcher_*.jar"))
core, = sorted((server / "plugins").glob("org.eclipse.jdt.ls.core_*.jar"))
config_name = "config_linux_arm" if platform.machine() in ("aarch64", "arm64") else "config_linux"
template = physical(str(server / config_name))
config_files = sorted(template.rglob("*"))
if len(config_files) > 64 or any(item.is_symlink() for item in config_files):
    raise ValueError("Invalid JDT configuration files")
configuration = [item for item in config_files if item.is_file()]
if template / "config.ini" not in configuration or sum(item.stat().st_size for item in configuration) > 2097152:
    raise ValueError("Invalid JDT configuration")
binary = physical(str(java / "bin" / "java"))
identity = fingerprint([release, binary, launcher, core, *configuration])
if mode == "inspect":
    print(json.dumps({"jdk": int(version.group(1)), "sha256": identity}))
    sys.exit(0)
if mode != "start" or identity != expected:
    raise ValueError("JDT runtime changed after approval")

env = dict(os.environ)
for key in ("CLIENT_PORT", "CLIENT_HOST", "CLIENT_PIPE", "SERVER_PORT", "SERVER_HOST", "JAVA_TOOL_OPTIONS",
            "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS", "CLASSPATH"):
    env.pop(key, None)
env["JAVA_HOME"] = str(java)
with tempfile.TemporaryDirectory(prefix="rocketbrain-jdt-") as owned:
    home = pathlib.Path(owned)
    config = home / "configuration"
    data = home / "data"
    shutil.copytree(template, config)
    data.mkdir()
    placeholders = {"@launcher": str(launcher), "@configuration": str(config), "@data": str(data)}
    args = [placeholders.get(arg, arg) for arg in json.loads(encoded)]
    child = subprocess.Popen([str(binary), *args], stdin=subprocess.PIPE, cwd=project, env=env)

    def relay():
        try:
            while True:
                data_chunk = os.read(0, 65536)
                if not data_chunk:
                    break
                child.stdin.write(data_chunk)
                child.stdin.flush()
            child.stdin.close()
            child.wait(timeout=6)
        except (BrokenPipeError, ProcessLookupError):
            pass
        except subprocess.TimeoutExpired:
            child.kill()

    threading.Thread(target=relay, daemon=True).start()
    sys.exit(child.wait())
`;

function javaRequest(input) {
  const { javaHome, serverPath, containerRoot } = input || {};
  for (const selected of [javaHome, serverPath, containerRoot]) pathSegments(selected);
  return { javaHome, serverPath, containerRoot };
}

function javaArguments(containerId, requested, identity) {
  const common = ['container', 'exec', '--interactive', containerId, 'python3', '-I', '-S', '-u', '-c', supervisor];
  const flags = identity ? jdtLaunchArguments({ launcher: '@launcher', configuration: '@configuration', data: '@data' }) : [];
  return [...common, identity ? 'start' : 'inspect', requested.javaHome, requested.serverPath, requested.containerRoot,
    identity || '', JSON.stringify(flags)];
}

function openJavaProcess(target, containerId, requested, identity) {
  return spawn(target.docker, ['--host=' + target.host, ...javaArguments(containerId, requested, identity)], {
    cwd: target.root, env: target.env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']
  });
}

module.exports = { javaArguments, javaRequest, openJavaProcess };
