#!/usr/bin/env python3
"""Run one cloud canary from an Android bootstrap sent over a private pipe."""
import base64
import json
import os
from pathlib import Path
import runpy
import sys

from curl_cffi import CurlOpt, requests


def main():
    os.umask(0o077)
    spec = json.load(sys.stdin)
    root = Path(__file__).resolve().parent
    driver = runpy.run_path(str(root / "driver.py"))["Driver"](runpy.run_path(str(root / "trace.py")))
    worker = runpy.run_path(str(root / "mac-worker.py"))
    control = worker["Control"]("http://127.0.0.1:3000", spec["workerKey"])

    def unpack(data):
        return data[0], data[1], base64.b64decode(data[2], validate=True)

    read, entry = unpack(spec["read"]), unpack(spec["entry"])
    job_target = spec["target"]
    with requests.Session(trust_env=False, default_headers=False, curl_options={CurlOpt.PATH_AS_IS: 1}) as client:
        task = driver.read_task(client, read, job_target)
    print("Cloud authenticated reward read passed; status", task.get("user_status"),
          "seconds", task.get("countdown_passed"), flush=True)

    job = control.post("poll", {"account": job_target["account"], "jobId": job_target["id"]}).get("job")
    if not job or any(job.get(k) != job_target[k] for k in ("id", "account", "campaign", "room", "task")):
        raise RuntimeError("The canary job is unavailable")

    def farm(_device, live_job, update, preserve):
        def progress(phase, seconds):
            update(phase, seconds)
            print("Cloud", phase, seconds, flush=True)
        return driver.complete(read, entry, live_job, progress, preserve)

    pending = root / "pending-result.json"
    worker["process"](control, job, farm, None, pending)
    print("Cloud worker reported its final result", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Cloud canary stopped ({type(error).__name__})", file=sys.stderr, flush=True)
        sys.exit(1)
