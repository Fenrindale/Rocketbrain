"""Owned loopback FTPS peers with a per-run, memory-originated test CA."""
import datetime
import importlib.metadata
import json
import logging
import pathlib
import sys
import threading

vendor = pathlib.Path(sys.argv[1]).resolve(strict=True)
sys.path.insert(0, str(vendor))
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
from OpenSSL import SSL
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler, TLS_DTPHandler, TLS_FTPHandler
from pyftpdlib.ioloop import IOLoop
from pyftpdlib.servers import FTPServer

config = json.loads(sys.stdin.readline())
root = pathlib.Path(config["root"]).resolve(strict=True)
assert root.name.startswith("rocketbrain-ftps-") and (root / ".owned").is_file()
assert importlib.metadata.version("pyftpdlib") == "2.2.0"
logging.getLogger("pyftpdlib").setLevel(logging.ERROR)


def new_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def issued(name, key, issuer_name=None, issuer_key=None):
    now = datetime.datetime.now(datetime.UTC)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)])
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(issuer_name or subject)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(minutes=1)).not_valid_after(now + datetime.timedelta(hours=1))
            .add_extension(x509.BasicConstraints(ca=issuer_name is None, path_length=None), critical=True))
    if issuer_name:
        cert = (cert.add_extension(x509.SubjectAlternativeName([x509.DNSName(name)]), critical=False)
                .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False))
    return cert.sign(issuer_key or key, hashes.SHA256())


ca_key = new_key()
ca = issued("Owned Rocketbrain FTPS test CA", ca_key)
(root / "ca.pem").write_bytes(ca.public_bytes(serialization.Encoding.PEM))


def server_context(prefix):
    key = new_key()
    cert = issued("localhost", key, ca.subject, ca_key)
    certfile = root / (prefix + "-cert.pem")
    keyfile = root / (prefix + "-key.pem")
    certfile.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    keyfile.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    context = SSL.Context(SSL.TLS_SERVER_METHOD)
    context.set_min_proto_version(SSL.TLS1_2_VERSION)
    context.use_certificate_chain_file(str(certfile))
    context.use_privatekey_file(str(keyfile))
    return context


primary = server_context("main")
alternate = server_context("other")
auth = DummyAuthorizer()
auth.add_user(config["user"], config["password"], str(root / "server"), perm="elrmw")
stats = {"loginCommands": 0, "uniqueWrites": 0, "createdFolders": 0, "protectedTransfers": 0}


class Instrumented:
    authorizer = auth

    def log(self, msg, logfun=None):
        return None

    def pre_process_command(self, line, cmd, arg):
        if cmd in ("USER", "PASS"):
            stats["loginCommands"] += 1
        if cmd in ("STOU", "MKD"):
            stats["uniqueWrites" if cmd == "STOU" else "createdFolders"] += 1
        if cmd in ("STOU", "RETR", "MLSD") and getattr(self, "_prot", False):
            stats["protectedTransfers"] += 1
        return super().pre_process_command(line, cmd, arg)


class Strict(Instrumented, TLS_FTPHandler):
    ssl_context = primary
    tls_control_required = True
    tls_data_required = True


class OtherDataCertificate(TLS_DTPHandler):
    def __init__(self, sock, cmd_channel):
        previous = cmd_channel.ssl_context
        try:
            cmd_channel.ssl_context = alternate
            super().__init__(sock, cmd_channel)
        finally:
            cmd_channel.ssl_context = previous


class MixedCertificates(Strict):
    dtp_handler = OtherDataCertificate


class PlainOnly(Instrumented, FTPHandler):
    pass


loop = IOLoop()
peers = [FTPServer(("127.0.0.1", 0), handler, ioloop=loop) for handler in (Strict, MixedCertificates, PlainOnly)]
thread = threading.Thread(target=peers[0].serve_forever, kwargs={"timeout": 0.1, "handle_exit": False}, daemon=True)
thread.start()
print(json.dumps({"ports": [peer.socket.getsockname()[1] for peer in peers], "version": importlib.metadata.version("pyftpdlib")}), flush=True)
try:
    for line in sys.stdin:
        if line.strip() == "stop":
            break
        if line.strip() == "stats":
            print(json.dumps(stats), flush=True)
finally:
    peers[0].close_all()
    thread.join(timeout=2)
