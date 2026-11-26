"""Disposable SFTP-only loopback server with an ephemeral host key."""
import asyncio
import hmac
import json
import pathlib
import sys

directory = pathlib.Path(sys.argv[1]).resolve(strict=True)
sys.path.insert(0, str(directory))
import asyncssh

config = json.loads(sys.stdin.readline())
root = pathlib.Path(config["root"]).resolve(strict=True)
assert root.name.startswith("rocketbrain-sftp-") and (root / ".owned").is_file()
assert asyncssh.__version__ == "2.24.1"
allowed_key = asyncssh.import_public_key(config["publicKey"]).public_data


class AuthFixture(asyncssh.SSHServer):
    def begin_auth(self, username):
        return True

    def password_auth_supported(self):
        return True

    def validate_password(self, username, password):
        stats["attempts"] += 1
        return username == config["user"] and hmac.compare_digest(password, config["password"])

    def public_key_auth_supported(self):
        return True

    def validate_public_key(self, username, key):
        stats["keyAttempts"] += 1
        return username == config["user"] and key.public_data == allowed_key


stats = {"attempts": 0, "keyAttempts": 0, "replacement": 0, "creation": 0, "mkdir": 0}


class SftpFixture(asyncssh.SFTPServer):
    def rename(self, oldpath, newpath):
        stats["creation"] += 1
        if newpath == b"/workspace/deploy/Race.java":
            # Simulate a second writer after the client's final reads.
            with (root / "server" / "workspace" / "deploy" / "Race.java").open("xb") as target:
                target.write(b"concurrent new file")
        return super().rename(oldpath, newpath)

    def posix_rename(self, oldpath, newpath):
        stats["replacement"] += 1
        return super().posix_rename(oldpath, newpath)

    def mkdir(self, path, attrs):
        stats["mkdir"] += 1
        return super().mkdir(path, attrs)


async def run():
    host_key = asyncssh.generate_private_key("ssh-ed25519")
    async with await asyncssh.create_server(
        AuthFixture, "127.0.0.1", 0, server_host_keys=[host_key],
        sftp_factory=lambda chan: SftpFixture(chan, chroot=str(root / "server")),
        allow_scp=False, encoding=None,
    ) as server:
        print(json.dumps({"port": server.get_port(), "fingerprint": host_key.get_fingerprint("sha256"), "version": asyncssh.__version__}), flush=True)
        while True:
            action = (await asyncio.to_thread(sys.stdin.readline)).strip()
            if action == "stats":
                print(json.dumps(stats), flush=True)
            if action in ("", "stop"):
                return


asyncio.run(run())
