"""Expose the Termux transport through the request interface the driver uses."""
import base64
import json
import os
import select
import subprocess
import time


class Response:
    def __init__(self, reply):
        self.status_code = reply["http"]
        self.content = base64.b64decode(reply["body"], validate=True)
        self.headers = {}

    def json(self):
        return json.loads(self.content)


class PhoneClient:
    def __init__(self, command):
        self.command = command
        self.process = None
        self.buffer = bytearray()

    def open(self):
        self.process = subprocess.Popen(self.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL)
        try:
            if self.read(9) != {"ready": True}:
                raise OSError("Phone bridge unavailable")
        except Exception:
            self.close()
            raise
        return self

    def close(self):
        process, self.process = self.process, None
        if process is None:
            return
        try:
            try:
                process.stdin.close()
            except BrokenPipeError:
                pass
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
        finally:
            process.stdout.close()
            self.buffer.clear()

    def read(self, timeout):
        deadline = time.monotonic() + timeout
        while b"\n" not in self.buffer:
            ready, _, _ = select.select([self.process.stdout], [], [], max(0, deadline - time.monotonic()))
            if not ready:
                raise TimeoutError("Phone request timed out")
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk or len(self.buffer) + len(chunk) > 3_000_000:
                raise OSError("Phone bridge disconnected")
            self.buffer.extend(chunk)
        line, _, rest = self.buffer.partition(b"\n")
        self.buffer = rest
        return json.loads(line)

    def request(self, method, url, *, data, headers, **_options):
        payload = json.dumps({"method": method, "url": url, "headers": headers,
                              "body": base64.b64encode(data or b"").decode()}).encode() + b"\n"
        self.process.stdin.write(payload)
        self.process.stdin.flush()
        reply = self.read(18)
        if "error" in reply:
            raise OSError("Phone request failed")
        return Response(reply)
