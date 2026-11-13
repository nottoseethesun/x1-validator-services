"""Stand-in for the validator's rpc: logs every request it receives.

It reads each request body, and answers /big with 16 MB, for the check that
nginx streams a large response without a temporary file.
"""
import http.server, json, sys
port, tag, logf = int(sys.argv[1]), sys.argv[2], sys.argv[3]
BIG_CHUNK = b"x" * (1024 * 1024)
class H(http.server.BaseHTTPRequestHandler):
    def _go(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        with open(logf, "a") as f:
            f.write(f"{tag} {self.command} {self.path} {length}\n")
        if self.path == "/big":
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(16 * len(BIG_CHUNK)))
            self.end_headers()
            for _ in range(16):
                self.wfile.write(BIG_CHUNK)
            return
        body = json.dumps({"backend": tag, "path": self.path}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    do_GET = do_POST = _go
    def log_message(self, *a):
        pass
http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
