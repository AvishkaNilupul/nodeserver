"""Existing authenticated job lease and durable result protocol."""
import http.client
import json
import os
import ssl
from urllib.parse import urlsplit

class LeaseLost(Exception):
    pass

class StopRequested(Exception):
    pass

class Control:
    def __init__(self, url, token):
        self.url = urlsplit(url)
        self.token = token
        if (not self.url.hostname or self.url.path not in ("", "/") or
                self.url.query or self.url.fragment or self.url.username or self.url.password):
            raise ValueError("Expected a bare control server URL")
        local_http = self.url.scheme == "http" and self.url.hostname in {"127.0.0.1", "localhost"}
        if self.url.scheme != "https" and not local_http:
            raise ValueError("HTTPS is required outside loopback")
        self.tls = ssl.create_default_context()

    def post(self, route, data):
        if self.url.scheme == "https":
            connection = http.client.HTTPSConnection(
                self.url.hostname, self.url.port, timeout=12, context=self.tls)
        else:
            connection = http.client.HTTPConnection(self.url.hostname, self.url.port, timeout=12)
        try:
            connection.request("POST", "/api/tiktok-farm/worker/" + route, json.dumps(data), {
                "Authorization": "Bearer " + self.token, "Content-Type": "application/json",
                "Accept": "application/json",
            })
            response = connection.getresponse()
            if response.status == 409:
                raise LeaseLost("run lease unavailable")
            if response.status != 200:
                raise OSError(f"control server HTTP {response.status}")
            return json.loads(response.read(65_536))
        finally:
            connection.close()

def process(control, job, run_farm, device, pending):
    run = {"id": job["id"], "lease": job["lease"]}
    seconds = 0
    phase = "bootstrap"

    def update(new_phase, progress):
        nonlocal phase, seconds
        reply = control.post("update", {**run, "phase": new_phase, "seconds": progress})
        phase, seconds = new_phase, progress
        if reply.get("stop"):
            raise StopRequested

    def preserve(code):
        result = {**run, "status": "completed", "seconds": seconds, "code": code}
        temporary = pending.with_suffix(".tmp")
        with temporary.open("w") as file:
            json.dump(result, file)
            file.flush()
            os.fsync(file.fileno())
        temporary.replace(pending)
        return result

    try:
        update("bootstrap", 0)
        result = run_farm(device, job, update, preserve)
        if result is None:
            raise RuntimeError("runner returned no outcome")
    except StopRequested:
        result = {**run, "status": "cancelled", "seconds": seconds}
    except LeaseLost:
        raise
    except Exception as error:
        reason = getattr(error, "phase", "worker-error")
        if phase == "claiming":
            reason = "claim-uncertain"
        result = {**run, "status": "failed", "phase": reason, "seconds": seconds}
    control.post("update", result)
    pending.unlink(missing_ok=True)
