'use strict';

const { deflateSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { filePrimitives, pythonCommand } = require('./ssh-files-worker');

const worker = filePrimitives + String.raw`
import re, signal

class Stale(ValueError):
    pass

def fingerprint(info):
    return digest(repr((info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
                        info.st_mode, info.st_nlink)).encode("ascii"))

def identity(info):
    return (info.st_dev, info.st_ino)

def stable_handle(info):
    return (*identity(info), info.st_size, info.st_mtime_ns)

def root_key(root):
    return digest(repr(identity(root.lstat())).encode("ascii"))

def utf8_text(data):
    if b"\0" in data:
        raise ValueError("binary")
    data.decode("utf-8", errors="strict")

def as_digest(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None

def validated_paths(root, targets):
    if not isinstance(targets, list) or not 2 <= len(targets) <= 8:
        raise ValueError("invalid-data")
    paths, seen = [], set()
    for item in targets:
        parts = item["parts"]
        if (not isinstance(parts, list) or not 1 <= len(parts) <= 32 or
            not all(name_ok(part) and not part.endswith((" ", ".")) and
                    not part.lower().startswith(".rocketbrain-batch-") for part in parts)):
            raise ValueError("invalid-path")
        target = root.joinpath(*parts)
        normalized = os.path.normcase(str(target))
        if normalized in seen:
            raise ValueError("duplicate")
        seen.add(normalized)
        paths.append((target, parts))
    return paths

def regular(stat_result):
    return (stat.S_ISREG(stat_result.st_mode) and stat_result.st_nlink == 1 and
            not (getattr(stat_result, "st_file_attributes", 0) & 0x400))

def snapshot(root, target, parts):
    resolved = checked_path(root, parts)
    if resolved != target or target.resolve(strict=True) != target:
        raise ValueError("indirection")
    parent = identity(target.parent.lstat())
    before = target.lstat()
    if not regular(before) or before.st_size > LIMIT:
        raise ValueError("unsupported")
    stamp = fingerprint(before)
    with target.open("rb") as file:
        if stable_handle(os.fstat(file.fileno())) != stable_handle(before):
            raise Stale("changed-file")
        data = file.read(LIMIT + 1)
        if len(data) > LIMIT or stable_handle(os.fstat(file.fileno())) != stable_handle(before):
            raise Stale("changed-file")
    if (fingerprint(checked_path(root, parts).lstat()) != stamp or identity(target.parent.lstat()) != parent):
        raise Stale("changed-file")
    return {"sha256": digest(data), "stamp": stamp, "size": len(data), "mode": stat.S_IMODE(before.st_mode),
            "identity": identity(before), "parent": parent, "data": data}

def public(snapshot):
    return {key: snapshot[key] for key in ("sha256", "stamp", "size")}

def match(image, expected):
    return image["sha256"] == expected["sha256"] and image["stamp"] == expected["stamp"]

def expect_image(image):
    if not isinstance(image, dict) or not as_digest(image.get("sha256")) or not as_digest(image.get("stamp")):
        raise ValueError("invalid-data")

def expected_set(root, paths, entries):
    visited, before, total = set(), [], 0
    for (target, parts), entry in zip(paths, entries):
        image = snapshot(root, target, parts)
        if image["identity"] in visited:
            raise ValueError("duplicate")
        visited.add(image["identity"])
        utf8_text(image["data"])
        total += image["size"]
        if total > LIMIT:
            raise ValueError("too-large")
        if entry.get("before") and not match(image, entry["before"]):
            raise Stale("changed-file")
        before.append(image)
    return before

def outcomes(rows, state, reason=None):
    result = {"state": state, "rows": rows}
    if reason:
        result["reason"] = reason
    return result

def stage_replacement(target, data, image):
    if identity(target.parent.lstat()) != image["parent"]:
        raise Stale("changed-file")
    endpoint = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", dir=target.parent, prefix=".rocketbrain-batch-", delete=False) as staged:
            endpoint = pathlib.Path(staged.name)
            staged.write(data)
            staged.flush()
            os.fsync(staged.fileno())
        endpoint.chmod(image["mode"])
        return (endpoint, identity(endpoint.lstat()))
    except BaseException:
        if endpoint:
            endpoint.unlink(missing_ok=True)
        raise

def discard(stages):
    for endpoint, expected in stages:
        try:
            if identity(endpoint.lstat()) == expected:
                endpoint.unlink()
        except OSError:
            continue

def rename_replacement(target, image, staged):
    temporary, expected = staged
    if identity(temporary.lstat()) != expected or identity(target.parent.lstat()) != image["parent"]:
        raise Stale("changed-file")
    if os.name == "nt":
        os.replace(temporary, target)
        return
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    directory = os.open(target.parent, flags)
    try:
        if identity(os.fstat(directory)) != image["parent"] or identity(os.stat(temporary.name, dir_fd=directory, follow_symlinks=False)) != expected:
            raise Stale("changed-file")
        os.replace(temporary.name, target.name, src_dir_fd=directory, dst_dir_fd=directory)
    finally:
        os.close(directory)

def apply_batch(root, paths, entries, original_root):
    rows = [{"state": "not-written"} for _ in paths]
    amounts, bytes_total, stages = [], 0, []
    for entry in entries:
        expect_image(entry.get("before"))
        if not isinstance(entry.get("content"), str) or not as_digest(entry.get("after")):
            raise ValueError("invalid-data")
        data = base64.b64decode(entry["content"], validate=True)
        utf8_text(data)
        bytes_total += len(data)
        if bytes_total > LIMIT:
            raise ValueError("too-large")
        if digest(data) != entry["after"] or entry["after"] == entry["before"]["sha256"]:
            raise ValueError("invalid-data")
        amounts.append(data)
    try:
        try:
            before = expected_set(root, paths, entries)
            if root_key(root) != original_root:
                raise Stale("changed-root")
        except (ValueError, OSError):
            return outcomes(rows, "refused", "preimage-changed")
        try:
            for (target, _), data, image in zip(paths, amounts, before):
                stages.append(stage_replacement(target, data, image))
        except (ValueError, OSError):
            return outcomes(rows, "refused", "staging-failed")
        try:
            current = expected_set(root, paths, entries)
            if root_key(root) != original_root or [image["parent"] for image in current] != [image["parent"] for image in before]:
                raise Stale("changed-file")
        except (ValueError, OSError):
            return outcomes(rows, "refused", "preimage-changed")

        for index, ((target, parts), image, entry, staged) in enumerate(zip(paths, before, entries, stages)):
            try:
                latest = snapshot(root, target, parts)
                if root_key(root) != original_root or latest["parent"] != image["parent"] or not match(latest, entry["before"]):
                    raise Stale("changed-file")
            except (ValueError, OSError):
                return outcomes(rows, "partial" if index else "refused", "preimage-changed")
            try:
                rename_replacement(target, image, staged)
            except (ValueError, OSError):
                rows[index] = {"state": "unconfirmed"}
                return outcomes(rows, "partial" if index else "unconfirmed", "replace-interrupted")
            try:
                installed = snapshot(root, target, parts)
                if installed["sha256"] != entry["after"] or installed["identity"] != staged[1]:
                    raise Stale("changed-file")
                rows[index] = {"state": "confirmed", **public(installed)}
            except (ValueError, OSError):
                rows[index] = {"state": "unconfirmed"}
                return outcomes(rows, "partial" if index else "unconfirmed", "readback-changed")
        return outcomes(rows, "applied")
    finally:
        discard(stages)

def observe_batch(root, paths, entries):
    rows = []
    for (target, parts), entry in zip(paths, entries):
        expect_image(entry.get("before"))
        if not as_digest(entry.get("after")):
            raise ValueError("invalid-data")
        try:
            image = snapshot(root, target, parts)
        except (FileNotFoundError, NotADirectoryError):
            rows.append({"state": "missing"})
            continue
        except (ValueError, OSError):
            rows.append({"state": "unavailable"})
            continue
        state = "preimage" if match(image, entry["before"]) else "replacement-bytes" if image["sha256"] == entry["after"] else "different"
        rows.append({"state": state, **public(image)})
    return {"rows": rows}

def execute(request):
    root = pathlib.Path(request["root"])
    if not root.is_absolute() or identify(root)["kind"] != "directory":
        raise ValueError("no-root")
    root = root.resolve(strict=True)
    if request["resolvedRoot"] != str(root):
        raise ValueError("changed-root")
    operation, entries = request["operation"], request["targets"]
    paths = validated_paths(root, entries)
    initial = root_key(root)
    if operation == "inspect-batch":
        images = expected_set(root, paths, entries)
        if root_key(root) != initial:
            raise ValueError("changed-root")
        return {"rootKey": initial, "rows": [public(image) for image in images]}
    if request["rootKey"] != initial:
        raise ValueError("changed-root")
    if operation == "apply-batch":
        return apply_batch(root, paths, entries, initial)
    if operation == "readback-batch":
        result = observe_batch(root, paths, entries)
        if root_key(root) != initial:
            raise ValueError("changed-root")
        return result
    raise ValueError("invalid-operation")

def disconnect(signum, frame):
    raise InterruptedError()

if os.name != "nt":
    signal.signal(signal.SIGHUP, disconnect)
    signal.signal(signal.SIGTERM, disconnect)
try:
    frame = sys.stdin.buffer.readline(4 * 1024 * 1024)
    if not frame.endswith(b"\n"):
        raise ValueError("too-large")
    response = {"value": execute(json.loads(frame))}
except FileNotFoundError:
    response = {"error": "missing"}
except PermissionError:
    response = {"error": "permission"}
except (KeyError, TypeError, ValueError) as error:
    allowed = ("unsupported", "indirection", "invalid-path", "changed-file", "changed-root", "missing", "too-large", "duplicate", "binary")
    code = str(error)
    response = {"error": code if code in allowed else "invalid-data"}
except OSError:
    response = {"error": "file-operation"}
print(json.dumps(response, ensure_ascii=True), flush=True)
`;

const payload = deflateSync(worker, { level: 9 }).toString('base64');
const hash = createHash('sha256').update(payload).digest('hex');
const batchProgram = "import base64, hashlib, sys, zlib\n" +
  "frame=sys.stdin.buffer.readline(12289)\n" +
  "if not frame.endswith(b'\\n') or hashlib.sha256(frame[:-1]).hexdigest()!='"+hash+"':\n" +
  "    raise ValueError('Unverified SSH batch worker source')\n" +
  "exec(zlib.decompress(base64.b64decode(frame[:-1], validate=True)))";

function batchCommand(python) { return pythonCommand(python, batchProgram); }
function batchFrame(body) { return payload + '\n' + body; }

module.exports = { batchCommand, batchFrame, batchProgram };
