"""One authenticated WebDAV share backed by an owned ephemeral folder."""
import importlib.metadata
import json
import pathlib
import sys
import threading
from wsgiref.simple_server import WSGIRequestHandler, make_server

sys.path.insert(0, str(pathlib.Path(sys.argv[1]).resolve(strict=True)))
from wsgidav.wsgidav_app import WsgiDAVApp

config = json.loads(sys.stdin.readline())
root = pathlib.Path(config["root"]).resolve(strict=True)
assert root.name.startswith("rocketbrain-webdav-") and (root / ".owned").is_file()
assert importlib.metadata.version("wsgidav") == "4.4.1"
app = WsgiDAVApp({
    "provider_mapping": {"/dav": str(root / "server")},
    "http_authenticator": {"accept_basic": True, "accept_digest": False, "default_to_digest": False},
    "simple_dc": {"user_mapping": {"*": {config["user"]: {"password": config["password"]}}}},
    "dir_browser": {"enable": False},
    "verbose": 0,
})
methods = {}


def instrumented(environ, start_response):
    method = environ["REQUEST_METHOD"]
    methods[method] = methods.get(method, 0) + 1
    return app(environ, start_response)


class Arrival(WSGIRequestHandler):
    def log_message(self, format, *args):
        return None


with make_server("127.0.0.1", 0, instrumented, handler_class=Arrival) as server:
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
    thread.start()
    print(json.dumps({"port": server.server_port, "version": importlib.metadata.version("wsgidav")}), flush=True)
    try:
        for line in sys.stdin:
            if line.strip() == "stop":
                break
            if line.strip() == "stats":
                print(json.dumps(methods), flush=True)
    finally:
        server.shutdown()
        thread.join(timeout=2)
