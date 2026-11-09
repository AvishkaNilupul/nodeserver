"""Provision a fresh, isolated TikTok emulator using the Mac's prepared SDK."""
import fcntl
import os
from pathlib import Path
import re
import runpy
import shutil
import subprocess
import time


ROOT = Path.home() / ".codex/project-memory/nodeserver/tiktok-mac"
RUNTIME = ROOT / "farm-runtime"
TRACE = ROOT / "protocol-research/native-trace"
SDK = Path.home() / "Library/Android/sdk"
ADB = SDK / "platform-tools/adb"
APP = "com.zhiliaoapp.musically"
ACTIVITY = APP + "/com.ss.android.ugc.aweme.splash.SplashActivity"


class SetupError(Exception):
    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)


class Device:
    def __init__(self, account, max_running=4):
        if not re.fullmatch(r"tiktok-(0[3-9]|[1-9][0-9])", account):
            raise SetupError("invalid-slot")
        self.account = account
        self.name = account + "-managed"
        self.state = RUNTIME / account
        self.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.pilot = runpy.run_path(str(ROOT / "tiktok_mac.py"))
        self.max_running = max_running

    def adb(self, *args, **options):
        options.setdefault("check", True)
        return subprocess.run([ADB, "-s", self.serial, *args], capture_output=True,
                              timeout=options.pop("timeout", 14), **options)

    def prepare(self):
        pilot = self.pilot
        with (ROOT / "instances.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            rows = pilot["records"]()
            row = rows.get(self.name)
            active = bool(row and pilot["is_active"](row))
            if not active:
                if sum(pilot["is_active"](value) for value in rows.values()) >= self.max_running:
                    raise SetupError("capacity")
                if shutil.disk_usage(ROOT).free < 12 * 1024**3:
                    raise SetupError("disk-space")
                if not row:
                    pilot["create"](rows, self.name, "play")
                    row = rows[self.name]
                    (self.state / 'temporary-device').touch(mode=0o600)
                ramdisk = TRACE / "tiktok-01-trace-ramdisk.img"
                if not ramdisk.is_file():
                    raise SetupError("sdk-assets")
                exe = pilot["native_executable"](self.name)
                with (self.state / "emulator.log").open("ab") as log:
                    process = subprocess.Popen(
                        [str(exe), "-avd", self.name, "-port", str(row["port"]), "-no-snapshot",
                         "-no-boot-anim", "-no-audio", "-no-metrics", "-memory", "2560", "-cores", "2",
                         "-ramdisk", str(ramdisk)],
                        env=pilot["env"](), stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                        start_new_session=True,
                    )
                row.update(pid=process.pid, memoryMiB=2560, headless=False)
                pilot["save"](rows)
            self.row = row
            self.serial = "emulator-" + str(row["port"])
        deadline = time.monotonic() + 135
        while time.monotonic() < deadline:
            try:
                if self.adb("shell", "getprop", "sys.boot_completed").stdout.strip() == b"1":
                    return
            except subprocess.SubprocessError:
                pass
            time.sleep(2)
        raise SetupError("boot-timeout")

    def install(self):
        snapshot = Path(__file__).with_name('ui-snapshot.jar')
        if snapshot.is_file():
            self.adb('push', str(snapshot), '/data/local/tmp/nodeserver-ui-snapshot.jar', timeout=30)
            self.snapshot_ready = True
        path = self.adb("shell", "pm", "path", APP, check=False).stdout.strip()
        if not path.startswith(b"package:"):
            subprocess.run([os.sys.executable, ROOT / "tiktok_mac.py", "install", self.name],
                           check=True, capture_output=True, timeout=195)
        foreground = self.adb("shell", "dumpsys activity activities | grep mResumedActivity || true").stdout
        if APP.encode() + b"/" not in foreground:
            self.adb("shell", "am", "start", "-n", ACTIVITY)
        elif b'.live.LivePlayActivity' in foreground:
            # A resumed policy checkpoint may still be inside the LIVE player.
            # Return to navigation so sign_in can verify the account's own profile.
            self.adb('shell', 'input', 'keyevent', '4')

    def tracing(self):
        root = "/debug_ramdisk/magisk"
        reply = self.adb("shell", root + " su -c id").stdout
        if b"uid=0(root)" not in reply:
            raise SetupError("trace-permission")
        if not self.adb("shell", "pidof tiktok-frida || true").stdout.strip():
            self.adb("push", TRACE / "server", "/data/local/tmp/tiktok-frida", timeout=60)
            self.adb("shell", "chmod 700 /data/local/tmp/tiktok-frida")
            self.adb("shell", root + " su -c 'nohup /data/local/tmp/tiktok-frida >/dev/null 2>&1 </dev/null &'")
        if not self.adb("shell", "pidof tiktok-frida || true").stdout.strip():
            raise SetupError("trace-permission")

    def stop(self):
        if not hasattr(self, 'serial'):
            return
        devices = subprocess.run([ADB, 'devices'], capture_output=True, timeout=8, check=True)
        if self.serial.encode() not in devices.stdout:
            return
        self.adb('emu', 'kill', check=False)
        for _ in range(30):
            result = subprocess.run([ADB, 'devices'], capture_output=True, timeout=8, check=True)
            if self.serial.encode() not in result.stdout:
                return
            time.sleep(1)
        raise SetupError('worker-error')

    def cleanup(self):
        """Release only this newly created, stopped setup device after phone ACK."""
        if not (self.state / 'temporary-device').exists():
            return False
        pilot = self.pilot
        with (ROOT / 'instances.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            rows = pilot['records']()
            row = rows.get(self.name)
            if row and pilot['is_active'](row):
                return False
            avds = pilot['AVDS'].resolve()
            device = avds / (self.name + '.avd')
            if device.is_symlink() or (device.exists() and device.resolve().parent != avds):
                raise SetupError('worker-error')
            if device.exists():
                shutil.rmtree(device)
            (avds / (self.name + '.ini')).unlink(missing_ok=True)
            rows.pop(self.name, None)
            pilot['save'](rows)
        for name in ('temporary-device', 'handoff-pending.json', 'identity-attempted', 'password-attempted', 'login-version'):
            (self.state / name).unlink(missing_ok=True)
        return True
