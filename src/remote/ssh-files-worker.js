'use strict';

const source = String.raw`
import base64, hashlib, json, os, pathlib, stat, sys, tempfile

LIMIT = 2 * 1024 * 1024

def name_ok(s):
    return isinstance(s, str) and s not in ("", ".", "..") and len(s) <= 255 and not any(
        ord(c) < 32 or c in "/\\:" for c in s)

def identify(p, stamped=False):
    info = p.lstat()
    if stat.S_ISLNK(info.st_mode) or (getattr(info, "st_file_attributes", 0) & 0x400):
        raise ValueError("indirection")
    if stat.S_ISREG(info.st_mode):
        result = {"kind": "file", "size": info.st_size, "modified": int(info.st_mtime * 1000)}
    elif stat.S_ISDIR(info.st_mode):
        result = {"kind": "directory", "size": 0, "modified": int(info.st_mtime * 1000)}
    else:
        raise ValueError("unsupported")
    if stamped:
        identity = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        result["stamp"] = hashlib.sha256(repr(identity).encode("ascii")).hexdigest()
    return result

def read_bytes(p):
    if identify(p)["kind"] != "file":
        raise ValueError("unsupported")
    with p.open("rb") as f:
        data = f.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise ValueError("too-large")
    return data

def digest(data):
    return hashlib.sha256(data).hexdigest()

def checked_path(root, parts):
    if not isinstance(parts, list) or len(parts) > 32 or not all(map(name_ok, parts)):
        raise ValueError("invalid-path")
    for part in parts:
        root = root / part
        identify(root)
    return root

def watch_states(root, targets):
    if not isinstance(targets, list) or not 1 <= len(targets) <= 64:
        raise ValueError("invalid-data")
    states = []
    for parts in targets:
        try:
            entry = identify(checked_path(root, parts), stamped=True)
            states.append({"kind": entry["kind"], "stamp": entry["stamp"]})
        except (FileNotFoundError, NotADirectoryError):
            states.append(None)
        except ValueError as reason:
            if str(reason) not in ("indirection", "unsupported"):
                raise
            states.append(None)
        except OSError:
            states.append(False)
    return states

def run(request):
    root = pathlib.Path(request["root"])
    if not root.is_absolute() or identify(root)["kind"] != "directory":
        raise ValueError("no-root")
    root = root.resolve(strict=True)
    if request.get("resolvedRoot") not in (None, str(root)):
        raise ValueError("changed-root")
    operation = request["operation"]
    p = checked_path(root, request.get("parts", []))
    if operation == "connect":
        return {"root": str(root)}
    if operation == "observe":
        return watch_states(root, request.get("targets"))
    if operation == "stat":
        return identify(p)
    if operation == "list":
        found = []
        for index, child in enumerate(p.iterdir()):
            if index >= 2000:
                raise ValueError("too-many-files")
            if not name_ok(child.name):
                continue
            try:
                found.append([child.name, identify(child)["kind"]])
            except (FileNotFoundError, ValueError):
                continue
        return found
    original = read_bytes(p)
    if operation == "read":
        return {"content": base64.b64encode(original).decode("ascii"), "sha256": digest(original)}
    if operation != "replace":
        raise ValueError("invalid-operation")
    if request["expected"] != digest(original) or p.lstat().st_nlink != 1:
        raise ValueError("changed-file")
    updated = base64.b64decode(request["content"], validate=True)
    if len(updated) > LIMIT:
        raise ValueError("too-large")
    mode = stat.S_IMODE(p.lstat().st_mode)
    with tempfile.NamedTemporaryFile(mode="wb", dir=p.parent, prefix=".rocketbrain-", delete=False) as f:
        temporary = pathlib.Path(f.name)
        try:
            f.write(updated)
            f.flush()
            os.fsync(f.fileno())
        except BaseException:
            f.close()
            temporary.unlink(missing_ok=True)
            raise
    try:
        temporary.chmod(mode)
        if request["expected"] != digest(read_bytes(p)) or p.lstat().st_nlink != 1:
            raise ValueError("changed-file")
        os.replace(temporary, p)
    finally:
        temporary.unlink(missing_ok=True)
    return {"sha256": digest(updated)}

try:
    frame = sys.stdin.buffer.readline(4 * 1024 * 1024)
    response = {"value": run(json.loads(frame))}
except FileNotFoundError:
    response = {"error": "missing"}
except PermissionError:
    response = {"error": "permission"}
except ValueError as error:
    allowed = {"indirection", "unsupported", "too-large", "no-root", "changed-root",
               "invalid-path", "too-many-files", "invalid-operation", "changed-file"}
    code = str(error)
    response = {"error": code if code in allowed else "invalid-data"}
except OSError:
    response = {"error": "file-operation"}
print(json.dumps(response, ensure_ascii=True), flush=True)
`;

function pythonCommand(python, program) {
  if (!['python3', 'python', 'py -3'].includes(python)) throw Error('Choose a supported remote Python launcher.');
  return python + ' -I -u -c "exec(__import__(\'base64\').b64decode(\'' + Buffer.from(program).toString('base64') + '\'))"';
}

function remoteCommand(python) { return pythonCommand(python, source); }

module.exports = { remoteCommand, pythonCommand, source };
