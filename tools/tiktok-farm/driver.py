"""Capture a single app session in memory, then complete a supported LIVE reward."""
from contextlib import contextmanager
import gzip
import io
import queue
import re
import subprocess
import sys
from threading import Timer
import time
from pathlib import Path
from urllib.parse import urlencode, urlsplit

import frida
from curl_cffi import CurlOpt, requests
from hpack import HPACKError


APP = "com.zhiliaoapp.musically"
DETAIL = "/webcast/partnership/reward/drops_detail/"
POLL = "/webcast/partnership/reward/drops_poll/"
ENTER = "/webcast/room/enter/"
CLAIM = "/webcast/partnership/reward/drops_claim/"
REGIONAL_HOST = "webcast22-normal-c-alisg.tiktokv.com"
ADB = Path.home() / "Library/Android/sdk/platform-tools/adb"


class FarmError(Exception):
    def __init__(self, phase):
        super().__init__(phase)
        self.phase = phase


@contextmanager
def frida_deadline(seconds=12):
    operation = frida.Cancellable()
    timer = Timer(seconds, operation.cancel)
    timer.daemon = True
    timer.start()
    try:
        with operation:
            yield
    finally:
        timer.cancel()


class Driver:
    def __init__(self, trace):
        self.trace = trace
        trace["HOSTS"].add(REGIONAL_HOST)

    def available(self, serial):
        try:
            device = frida.get_device(serial, timeout=3)
            with frida_deadline(5):
                return any(app.identifier == APP for app in device.enumerate_applications())
        except (frida.TimedOutError, frida.ServerNotRunningError, frida.TransportError, frida.OperationCancelledError, OSError):
            return False

    def entry_room(self, entry):
        host, headers, body = entry
        if body.startswith(b"\x1f\x8b"):
            try:
                with gzip.GzipFile(fileobj=io.BytesIO(body)) as stream:
                    clear = stream.read(65_537)
                if len(clear) > 65_536:
                    return None
                return self.trace["android_room"]((host, headers, clear))
            except (OSError, EOFError):
                return None
        return self.trace["android_room"](entry)

    def capture(self, serial, job, update):
        device = frida.get_device(serial, timeout=5)

        def shell(command, **options):
            return subprocess.run([ADB, "-s", serial, "shell", command], timeout=12,
                                  capture_output=True, **options)

        with frida_deadline():
            app = next((app for app in device.enumerate_applications() if app.identifier == APP), None)
        if not app:
            raise FarmError("session-required")
        if not app.pid:
            shell(f"monkey -p {APP} -c android.intent.category.LAUNCHER 1", check=True)
            time.sleep(12)
            update("bootstrap", 0)
            with frida_deadline():
                app = next(app for app in device.enumerate_applications() if app.identifier == APP)
        if not app.pid:
            raise FarmError("session-required")
        with frida_deadline():
            session = device.attach(app.pid)
        events = queue.Queue(maxsize=1024)

        def receive(message, data):
            if not data:
                return
            try:
                events.put_nowait((message["payload"], data))
            except queue.Full:
                pass

        readers, uploads, matched = {}, {}, {}
        failed = set()
        observations = {"reward_reads": 0, "room_entries": 0}
        rules = []
        uid_line = shell(f"cmd package list packages -U {APP}", check=True, text=True).stdout
        uid = re.search(r"uid:(\d+)", uid_line)
        if not uid:
            session.detach()
            raise FarmError("session-required")
        rule = f"OUTPUT -m owner --uid-owner {uid[1]} -p udp --dport 443 -j REJECT"

        def firewall(tool, action):
            shell(f"/debug_ramdisk/magisk su -c '{tool} -w 4 {action} {rule}'", check=True)

        try:
            script = session.create_script(self.trace["SOURCE"])
            script.on("message", receive)
            with frida_deadline():
                script.load()
            for tool in ("iptables", "ip6tables"):
                firewall(tool, "-I")
                rules.append(tool)
            sockets = shell("/debug_ramdisk/magisk su -c 'ss -tnp'", text=True, check=True).stdout
            for line in sockets.splitlines():
                fields = line.split()
                if len(fields) < 6 or fields[0] != "ESTAB" or f"pid={app.pid}," not in line or not fields[4].endswith(":443"):
                    continue
                port = fields[3].rsplit(":", 1)[-1]
                if port.isdigit():
                    shell(f"/debug_ramdisk/magisk su -c 'ss -Ktn sport = :{port} dport = :443'")
            shell(f"am start -a android.intent.action.VIEW -d https://www.tiktok.com/share/live/{job['room']} -p {APP}", check=True)
            deadline = time.monotonic() + 75
            renew = time.monotonic() + 15
            while time.monotonic() < deadline:
                if time.monotonic() >= renew:
                    update("bootstrap", 0)
                    renew = time.monotonic() + 15
                try:
                    event, data = events.get(timeout=1)
                except queue.Empty:
                    continue
                host = event["host"]
                if event["direction"] != "out" or not self.trace["origin_allowed"](host):
                    continue
                key = event["connection"]
                if key in failed:
                    continue
                reader = readers.setdefault(key, self.trace["FrameStream"](True))
                try:
                    for stream, kind, payload, ended in reader.append(data):
                        key_stream = (key, stream)
                        if kind == "headers":
                            headers = [(name, value) for name, value in payload if not name.startswith("x-unknown-index-")]
                            route, fields = self.trace["clean_route"](headers)
                            if not self.trace["origin_allowed"](fields.get(":authority")):
                                continue
                            if route in (DETAIL, POLL):
                                observations["reward_reads"] += 1
                                ids = self.trace["public_query"](fields)
                                if (ids.get("drops_id") == job["campaign"] and ids.get("room_id") == job["room"]
                                        and "anchor_id" in ids and {"cookie", "x-tt-token"} <= fields.keys()):
                                    matched["read"] = (host, headers, b"")
                            if route == ENTER and not ended:
                                observations["room_entries"] += 1
                                needed = {"cookie", "x-tt-token", "tt-ticket-guard-client-data"}
                                if needed <= fields.keys():
                                    uploads[key_stream] = (host, headers, bytearray())
                        elif key_stream in uploads:
                            upload = uploads[key_stream]
                            if len(upload[2]) + len(payload) > 65_536:
                                uploads.pop(key_stream)
                                continue
                            upload[2].extend(payload)
                            if ended:
                                uploads.pop(key_stream)
                                entry = (upload[0], upload[1], bytes(upload[2]))
                                if self.entry_room(entry) == job["room"]:
                                    matched["entry"] = entry
                    if matched.keys() >= {"read", "entry"}:
                        return matched["read"], matched["entry"]
                except (ValueError, IndexError, HPACKError):
                    failed.add(key)
        finally:
            try:
                for tool in reversed(rules):
                    try:
                        firewall(tool, "-D")
                    except (subprocess.SubprocessError, OSError):
                        print(f"Temporary {tool} rule cleanup failed on {serial}", file=sys.stderr, flush=True)
            finally:
                session.detach()
        print(f"{serial} bootstrap timed out ({observations}, matched {sorted(matched)})",
              file=sys.stderr, flush=True)
        raise FarmError("session-required")

    def mac(self, client, capture, **options):
        host, headers, body = capture
        if host in {"aggr16-normal.tiktokv.us", "aggr19-normal.tiktokv.us"}:
            host = "tnc16-normal-useast8.tiktokv.us"
        if options.get("json_format") and not any(key == "response-format" for key, _ in headers):
            headers = [*headers, ("response-format", "json")]
        return self.trace["mac_request"](client, (host, headers, body), **options)

    def read_task(self, client, read, job):
        result = self.mac(client, read, include_payload=True, json_format=True)
        if result.get("business") != 0:
            print(f"TikTok reward read HTTP {result.get('http')}, status {result.get('business')}",
                  file=sys.stderr, flush=True)
            raise FarmError("session-required")
        data = result["_payload"].get("data") or {}
        tasks = data.get("tasks") or (data.get("detail") or {}).get("tasks") or []
        if job["task"] == "auto":
            eligible = [task for task in tasks if task.get("type") == 5
                        and task.get("user_status") in (1, 3) and task.get("id")
                        and not (task.get("gift") or {}).get("need_auth")]
            if len(eligible) != 1:
                raise FarmError("ineligible")
            task = eligible[0]
        else:
            task = next((task for task in tasks if str(task.get("id")) == job["task"]), None)
        if not task or task.get("type") != 5 or (task.get("gift") or {}).get("need_auth"):
            raise FarmError("ineligible")
        return task

    def run(self, serial, job, update, preserve):
        if (any(not re.fullmatch(r"[0-9]{1,22}", job.get(key, "")) for key in ("campaign", "room"))
                or not re.fullmatch(r"(?:[0-9]{1,22}|auto)", job.get("task", ""))):
            raise FarmError("worker-error")
        read, entry = self.capture(serial, job, update)
        with requests.Session(trust_env=False, default_headers=False,
                              curl_options={CurlOpt.PATH_AS_IS: 1}) as client:
            task = self.read_task(client, read, job)
            job = {**job, "task": str(task["id"])}
            if task.get("user_status") not in (1, 3):
                raise FarmError("ineligible")
            remaining = task.get("view_duration")
            if not isinstance(remaining, int) or not 1 <= remaining <= 1800:
                raise FarmError("ineligible")
            subprocess.run([ADB, "-s", serial, "shell", "am", "force-stop", APP], timeout=12, check=True)
            pid = subprocess.run([ADB, "-s", serial, "shell", "pidof", APP], timeout=12, capture_output=True)
            if pid.stdout.strip():
                raise FarmError("worker-error")
            update("watching", int(task.get("countdown_passed") or 0))
            result = self.mac(client, entry, refresh=False, json_format=True)
            if result.get("business") != 0:
                raise FarmError("room-ended")
            deadline = time.monotonic() + remaining + 45
            while task.get("user_status") == 1 and time.monotonic() < deadline:
                time.sleep(12)
                task = self.read_task(client, read, job)
                update("watching", int(task.get("countdown_passed") or 0))
            if task.get("user_status") != 3:
                raise FarmError("ineligible")

            host, headers, _ = read
            fields = dict(headers)
            ids = self.trace["public_query"](fields)
            query = "&".join(part for part in urlsplit(fields[":path"]).query.split("&")
                             if part.partition("=")[0] not in {"drops_id", "room_id", "anchor_id", "user_type"})
            form = urlencode({**ids, "task_id": job["task"], "input": "{}"}).encode()
            send = [(k, v) for k, v in headers if k not in {":path", ":method", "content-type", "x-ss-stub"}]
            send.extend([(":path", CLAIM + "?" + query), (":method", "POST"),
                         ("content-type", "application/x-www-form-urlencoded; charset=UTF-8")])
            update("claiming", int(task.get("countdown_passed") or 0))
            result = self.mac(client, (host, send, form), include_payload=True, json_format=True)
            code = (result.get("_payload", {}).get("data") or {}).get("cdkey")
            if not isinstance(code, str) or not re.fullmatch(r"[\x21-\x7e]{1,512}", code):
                raise FarmError("claim-uncertain")
            return preserve(code)
