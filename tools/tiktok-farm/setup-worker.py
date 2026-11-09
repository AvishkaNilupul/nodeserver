#!/usr/bin/env python3
"""Complete new TikTok account setups on the local Mac."""
import argparse
import fcntl
import os
from pathlib import Path
import runpy
import re
import subprocess
import time


HERE = Path(__file__).resolve().parent
device_tools = runpy.run_path(str(HERE / "enroll-device.py"))
login_tools = runpy.run_path(str(HERE / "enroll-login.py"))
worker_tools = runpy.run_path(str(HERE / "mac-worker.py"))
RUNTIME, TRACE = device_tools["RUNTIME"], device_tools["TRACE"]


def capacity(max_running):
    pilot = runpy.run_path(str(device_tools['ROOT'] / 'tiktok_mac.py'))
    active = [name for name, row in pilot['records']().items() if pilot['is_active'](row)]
    accounts = [name.removesuffix('-managed') for name in active
                if re.fullmatch(r'tiktok-(0[3-9]|[1-9][0-9])-managed', name)]
    return {'capacityAvailable': len(active) < max_running, 'activeAccounts': accounts[:8]}


def live_room(hint):
    from curl_cffi import requests
    def alive(room):
        if not re.fullmatch(r'[0-9]{1,22}', room or ''):
            return False
        try:
            data = requests.get('https://webcast.tiktok.com/webcast/room/check_alive/',
                params={'aid': 1988, 'region': 'JP', 'room_ids': room, 'user_is_login': 'false'},
                impersonate='chrome', timeout=8).json().get('data') or []
            return any(str(row.get('room_id')) == room and row.get('alive') for row in data)
        except Exception:
            return False
    if alive(hint):
        return hint
    handles = os.environ.get('TIKTOK_SETUP_LIVE_HANDLES',
        'supremolives,zuxra21_01,pinosanz,rr10ou,nabina112,yakitorichan02').split(',')
    for handle in handles[:8]:
        if not re.fullmatch(r'[a-zA-Z0-9_.]{1,35}', handle):
            continue
        try:
            data = requests.get('https://www.tiktok.com/api-live/user/room/',
                params={'aid': 1988, 'app_name': 'tiktok_web', 'device_platform': 'web_pc',
                        'uniqueId': handle, 'sourceType': 54}, impersonate='chrome', timeout=7).json().get('data') or {}
            room = str((data.get('user') or {}).get('roomId') or '')
            if (data.get('liveRoom') or {}).get('status') == 2 and alive(room):
                return room
        except Exception:
            continue
    raise login_tools['LoginAttention']('no-live-room')


def capture(device, room, update):
    from session_capture import WireCapture, pack_session
    driver = runpy.run_path(str(HERE / 'driver.py'))['Driver'](runpy.run_path(str(TRACE / 'happy-watch-control.py')))
    room = live_room(room)
    device.adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d',
               'https://www.tiktok.com/share/live/' + room, '-p', device_tools['APP'])
    for _ in range(12):
        activity = device.adb('shell', 'dumpsys activity activities | grep mResumedActivity || true').stdout
        if b'.live.LivePlayActivity' in activity:
            break
        if login_tools['challenge'](login_tools['nodes'](device)):
            raise login_tools['LoginAttention']('verification-required')
        time.sleep(2)
    else:
        raise login_tools['LoginAttention']('app-not-ready')
    time.sleep(5)
    device.adb('shell', 'input', 'keyevent', '4')
    time.sleep(2)
    wire = WireCapture()
    # Capture a real LIVE entry. A stale discovery hint simply pauses setup for retry.
    _, seed = driver.capture(device.serial, {'room': room, 'discovery': True},
                             lambda *_: update('capturing'), wire_capture=wire)
    return pack_session(device.account, seed, wire)


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

    attention = False
    try:
        device.prepare()
        update("installing")
        version = device.state / 'login-version'
        current_version = job.get('credentialVersion') or ''
        if version.exists() and version.read_text() != current_version:
            device.adb('shell', 'pm', 'clear', device_tools['APP'])
            for marker in ('identity-attempted', 'password-attempted'):
                (device.state / marker).unlink(missing_ok=True)
        version.write_text(current_version)
        device.install()
        update("signing-in")
        handle = login_tools["sign_in"](device, job["credential"], update)
        update("verifying")
        device.tracing()
        update("capturing")
        try:
            packet = capture(device, job["seedRoom"], update)
        except login_tools["LoginAttention"]:
            raise
        except Exception:
            raise login_tools["LoginAttention"]("capture-timeout") from None
        # Shut down Android before publishing this account to the API farm.
        device.stop()
        update("registering")
        control.post("setup/session", {"account": account, "lease": job["lease"], "handle": handle,
            "credentialVersion": job.get("credentialVersion"), "packet": packet})
        print(f"{account} transferred to phone", flush=True)
    except login_tools["LoginAttention"] as error:
        attention = error.reason == "verification-required"
        update("attention", error.reason)
    except device_tools["SetupError"] as error:
        update("attention" if error.reason == "trace-permission" else "failed", error.reason)
    except worker_tools["LeaseLost"]:
        raise
    except (OSError, ValueError, subprocess.SubprocessError):
        update("failed", "worker-error")
    finally:
        if not attention:
            device.stop()




def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", required=True)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--max-running", type=int, default=1, choices=range(1, 9))
    args = parser.parse_args()
    os.umask(0o077)
    key = args.key_file.read_text().strip()
    if len(key) < 32 or args.key_file.stat().st_mode & 0o077:
        parser.error("A private setup key file is required")
    control = worker_tools["Control"](args.server, key)
    with (RUNTIME / "setup-worker.lock").open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        while True:
            try:
                if job := control.post("setup/poll", capacity(args.max_running)).get("job"):
                    setup(control, job, args)
            except (OSError, ValueError, subprocess.SubprocessError, device_tools["SetupError"], worker_tools["LeaseLost"]):
                print("Setup control unavailable", flush=True)
                time.sleep(12)
            time.sleep(6)


if __name__ == "__main__":
    main()
