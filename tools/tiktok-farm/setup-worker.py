#!/usr/bin/env python3
"""Complete new TikTok account setups on the local Mac."""
import argparse
import fcntl
import os
from pathlib import Path
import plistlib
import runpy
import subprocess
import sys
import time


HERE = Path(__file__).resolve().parent
device_tools = runpy.run_path(str(HERE / "enroll-device.py"))
login_tools = runpy.run_path(str(HERE / "enroll-login.py"))
worker_tools = runpy.run_path(str(HERE / "mac-worker.py"))
RUNTIME, TRACE = device_tools["RUNTIME"], device_tools["TRACE"]


def register(device, server):
    account = device.account
    label = "local.nodeserver.tiktok-farm." + account
    plist = Path.home() / "Library/LaunchAgents" / (label + ".plist")
    domain = f"gui/{os.getuid()}"
    configuration = {
        "Label": label,
        "ProgramArguments": [
            sys.executable, str(HERE / "mac-worker.py"), "--account", account, "--device", device.serial,
            "--server", server, "--key-file", str(RUNTIME / "worker-key"), "--state", str(device.state),
            "--trace", str(TRACE / "happy-watch-control.py"),
        ],
        "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 10,
        "WorkingDirectory": str(RUNTIME),
        "StandardOutPath": str(device.state / "worker.log"),
        "StandardErrorPath": str(device.state / "worker.log"),
    }
    if plist.exists():
        if plistlib.loads(plist.read_bytes()) != configuration:
            raise device_tools["SetupError"]("worker-error")
    else:
        with plist.open("xb") as handle:
            plistlib.dump(configuration, handle)
    args = ["launchctl", "print", f"{domain}/{label}"]
    if subprocess.run(args, capture_output=True, timeout=8).returncode:
        subprocess.run(["launchctl", "bootstrap", domain, plist], check=True, capture_output=True, timeout=12)
    subprocess.run(args, check=True, capture_output=True, timeout=8)
    (device.state / "registered").touch(mode=0o600)


def setup(control, job, args):
    account = job["account"]
    device = device_tools["Device"](account, args.max_running)

    def update(state, reason=None, handle=None):
        payload = {"account": account, "lease": job["lease"], "state": state}
        if hasattr(device, "serial"):
            payload["serial"] = device.serial
        if reason:
            payload["reason"] = reason
        if handle:
            payload["handle"] = handle
        control.post("setup/update", payload)
        print(f"{account} {state}" + (f" ({reason})" if reason else ""), flush=True)

    try:
        device.prepare()
        update("installing")
        device.install()
        update("signing-in")
        handle = login_tools["sign_in"](device, job["credential"], update)
        update("verifying")
        device.tracing()
        try:
            driver = runpy.run_path(str(HERE / "driver.py"))["Driver"](runpy.run_path(str(TRACE / "happy-watch-control.py")))
            driver.catalog(device.serial, job.get("seedRoom") or "7704940109955353374")
        except Exception:
            raise login_tools["LoginAttention"]("session-check") from None
        update("registering")
        register(device, args.server)
        update("ready", handle=handle)
    except login_tools["LoginAttention"] as error:
        update("attention", error.reason)
    except device_tools["SetupError"] as error:
        update("attention" if error.reason == "trace-permission" else "failed", error.reason)
    except worker_tools["LeaseLost"]:
        raise
    except (OSError, ValueError, subprocess.SubprocessError):
        update("failed", "worker-error")


def restore(args):
    for marker in sorted(RUNTIME.glob("tiktok-*/registered")):
        try:
            device = device_tools["Device"](marker.parent.name, args.max_running)
            device.prepare()
            device.tracing()
            register(device, args.server)
        except (OSError, ValueError, subprocess.SubprocessError, device_tools["SetupError"]):
            print(f"{marker.parent.name} could not restart", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", required=True)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--max-running", type=int, default=4, choices=range(3, 9))
    args = parser.parse_args()
    os.umask(0o077)
    key = args.key_file.read_text().strip()
    if len(key) < 32 or args.key_file.stat().st_mode & 0o077:
        parser.error("A private setup key file is required")
    control = worker_tools["Control"](args.server, key)
    with (RUNTIME / "setup-worker.lock").open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        restore(args)
        while True:
            try:
                if job := control.post("setup/poll", {}).get("job"):
                    setup(control, job, args)
            except (OSError, ValueError, worker_tools["LeaseLost"]):
                print("Setup control unavailable", flush=True)
                time.sleep(12)
            time.sleep(6)


if __name__ == "__main__":
    main()
