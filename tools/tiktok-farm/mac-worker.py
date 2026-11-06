#!/usr/bin/env python3
"""Run one leased TikTok farm job at a time on an existing Mac Android session."""
import argparse
import fcntl
import http.client
import json
import os
import re
from pathlib import Path
import runpy
import sys
import time
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

    def post(self, route, data):
        transport = http.client.HTTPSConnection if self.url.scheme == "https" else http.client.HTTPConnection
        connection = transport(self.url.hostname, self.url.port, timeout=12)
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account", required=True)
    parser.add_argument("--device", required=True)
    parser.add_argument("--server", required=True)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--trace", type=Path, required=True, help="Private reward trace helper from the Mac trial")
    args = parser.parse_args()
    if not re.fullmatch(r"emulator-[0-9]{4,5}", args.device):
        parser.error("Expected an Android emulator serial")
    os.umask(0o077)
    token = args.key_file.read_text().strip()
    if len(token) < 32 or args.key_file.stat().st_mode & 0o077:
        parser.error("Expected a private worker key file")
    args.state.mkdir(mode=0o700, parents=True, exist_ok=True)
    if args.state.stat().st_mode & 0o077:
        parser.error("Worker state directory must be private")
    control = Control(args.server, token)
    private_trace = runpy.run_path(str(args.trace))
    driver = runpy.run_path(str(Path(__file__).with_name("driver.py")))["Driver"](private_trace)
    lock = args.state / "worker.lock"
    pending = args.state / "pending-result.json"
    with lock.open("a") as held:
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        while True:
            try:
                if pending.is_file():
                    control.post("update", json.loads(pending.read_text()))
                    pending.unlink()
                if not driver.available(args.device):
                    time.sleep(6)
                    continue
                reply = control.post("poll", {"account": args.account})
                job = reply.get("job")
                if job:
                    process(control, job, driver.run, args.device, pending)
            except (OSError, ValueError, LeaseLost) as error:
                print(f"Control update unavailable ({type(error).__name__})", file=sys.stderr, flush=True)
                time.sleep(10)
            time.sleep(6)


if __name__ == "__main__":
    main()
