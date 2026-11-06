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
from urllib.parse import urlencode, urlsplit, urlunsplit

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
    def __init__(self, trace, phone_client=None):
        self.trace = trace
        self.phone_client = phone_client
        self.api_route = None
        trace["HOSTS"].add(REGIONAL_HOST)
        trace["mac_request"].__globals__["REWARD"] = re.compile(
            r"^/webcast/partnership/reward/drops_(detail|poll|list/v2|page_feed)/$"
        )

    @contextmanager
    def http_session(self):
        if self.phone_client:
            try:
                phone = self.phone_client().open()
            except (OSError, ValueError):
                phone = None
            if phone:
                self.api_route = "phone"
                try:
                    yield phone
                finally:
                    phone.close()
                return
        self.api_route = "mac"
        with requests.Session(trust_env=False, default_headers=False, curl_options={CurlOpt.PATH_AS_IS: 1}) as client:
            yield client

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
        discovery = job.get("discovery") is True

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
                            if (discovery and fields[":authority"].startswith("webcast") and route.startswith("/webcast/")
                                    and fields.get(":method") == "GET" and {"cookie", "x-tt-token"} <= fields.keys()):
                                return (host, headers, b""), None
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
                    if "entry" in matched and (job.get("campaign") is None or "read" in matched):
                        return matched.get("read"), matched["entry"]
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
                try:
                    with frida_deadline():
                        session.detach()
                except (frida.TransportError, frida.InvalidOperationError, frida.OperationCancelledError):
                    pass
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
        anchor = job.get("anchor")
        if job.get("automatic") is True and anchor and re.fullmatch(r"[0-9]{1,22}", anchor):
            # The captured entry is emitted by the real player. Keep it open
            # for watch credit and let the API read progress and claim.
            try:
                _, entry = self.capture(serial, {"room": job["room"]}, update)
                read = self.get_from_entry(entry, DETAIL, drops_id=job["campaign"], room_id=job["room"],
                                           anchor_id=anchor, user_type=0)
                return self.complete(read, entry, job, update, preserve, native_playback=True)
            finally:
                try:
                    self.stop_app(serial)
                except (FarmError, subprocess.SubprocessError, OSError):
                    print(f"Could not stop Android playback on {serial}", file=sys.stderr, flush=True)
        if anchor and re.fullmatch(r"[0-9]{1,22}", anchor):
            _, entry = self.capture(serial, {"room": job["room"]}, update)
            read = self.get_from_entry(entry, DETAIL, drops_id=job["campaign"], room_id=job["room"],
                                       anchor_id=anchor, user_type=0)
        else:
            read, entry = self.capture(serial, job, update)
        self.stop_app(serial)
        return self.complete(read, entry, job, update, preserve)

    @staticmethod
    def stop_app(serial):
        subprocess.run([ADB, "-s", serial, "shell", "am", "force-stop", APP], timeout=12, check=True)
        pid = subprocess.run([ADB, "-s", serial, "shell", "pidof", APP], timeout=12, capture_output=True)
        if pid.stdout.strip():
            raise FarmError("worker-error")

    def catalog(self, serial, room):
        try:
            read, entry = self.capture(serial, {"room": room, "discovery": True}, lambda *_: None)
        finally:
            self.stop_app(serial)
        return self.catalog_from_entry(read or entry, include_upcoming=True)

    @staticmethod
    def get_from_entry(entry, route, **params):
        host, headers, _ = entry
        original = urlsplit(dict(headers)[":path"])
        scope = {"drops_id", "room_id", "anchor_id", "user_type", "is_refresh", "is_subscribing"}
        query = [p for p in original.query.split("&") if p and p.partition("=")[0] not in scope]
        if params:
            query.append(urlencode(params))
        excluded = {":path", "content-type", "content-length", "x-bd-content-encoding", "x-ss-stub", "response-format"}
        headers = [(k, "GET" if k == ":method" else v) for k, v in headers
                   if k not in excluded and not k.startswith("tt-ticket-guard-")]
        path = urlunsplit(original._replace(path=route, query="&".join(query)))
        return host, [*headers, (":path", path)], b""

    def catalog_from_entry(self, entry, *, include_upcoming=False):
        with self.http_session() as client:
            def fetch(route, **params):
                result = self.mac(client, self.get_from_entry(entry, route, **params),
                                  include_payload=True, json_format=True)
                if result.get("business") != 0:
                    raise FarmError("session-required")
                return result["_payload"].get("data") or {}

            prefix = "/webcast/partnership/reward/"
            data = fetch(prefix + "drops_list/v2/")
            campaigns = {}

            def collect(value, target):
                if isinstance(value, dict):
                    name = value.get("drops_name") or value.get("name") or value.get("title")
                    cid = str(value.get("drops_id") or value.get("id") or "")
                    if (isinstance(name, str) and re.fullmatch(r"[0-9]{16,22}", cid)
                            and any(k in value for k in ("drops_id", "game_name", "tasks", "gifts", "end_time"))):
                        target[cid] = (name.strip()[:100], value)
                    for item in value.values():
                        collect(item, target)
                elif isinstance(value, list):
                    for item in value:
                        collect(item, target)

            collect(data.get("ongoing_drops_list") or [], campaigns)
            collect(data.get("current_drops") or [], campaigns)
            events = []
            for cid, (name, _) in list(campaigns.items())[:12]:
                rooms = fetch(prefix + "drops_page_feed/", drops_id=cid, is_refresh="true").get("room_list") or []
                for room in rooms[:2]:
                    rid, aid = str(room.get("room_id", "")), str(room.get("anchor_id", ""))
                    if not all(re.fullmatch(r"[0-9]{16,22}", value) for value in (rid, aid)):
                        continue
                    detail = fetch(DETAIL, drops_id=cid, room_id=rid, anchor_id=aid, user_type=0)
                    tasks = detail.get("tasks") or (detail.get("detail") or {}).get("tasks") or []
                    candidates = []
                    for task in tasks:
                        tid = str(task.get("id", ""))
                        duration = task.get("view_duration")
                        status = task.get("user_status")
                        if (task.get("type") == 5 and status in (1, 3) and re.fullmatch(r"[0-9]{1,22}", tid)
                                and isinstance(duration, int) and 1 <= duration <= 1800
                                and not (task.get("gift") or {}).get("need_auth")):
                            seconds = task.get("countdown_passed")
                            seconds = min(duration, max(0, seconds)) if isinstance(seconds, int) else 0
                            candidates.append({"campaign": cid, "name": name, "room": rid, "anchor": aid, "task": tid,
                                               "duration": duration, "remaining": 0 if status == 3 else duration - seconds})
                    if candidates:
                        events.extend(candidates)
                        break
            events = sorted(events, key=lambda event: (event["remaining"], event["duration"], event["campaign"]))[:30]
            if not include_upcoming:
                return events
            upcoming = {}
            collect(data.get("upcoming_drops_list") or [], upcoming)

            def timestamp(value):
                if isinstance(value, str) and value.isdecimal() and len(value) <= 13:
                    value = int(value)
                if not isinstance(value, int):
                    return None
                millis = value * 1000 if value < 10_000_000_000 else value
                return millis if 946684800000 <= millis < 4102444800000 else None

            return {"events": events, "upcoming": [
                {"campaign": cid, "name": name, "startsAt": timestamp(row.get("start_time")),
                 "endsAt": timestamp(row.get("end_time"))}
                for cid, (name, row) in list(upcoming.items())[:30] if name
            ]}

    def complete(self, read, entry, job, update, preserve, *, native_playback=False):
        with self.http_session() as client:
            task = self.read_task(client, read, job)
            job = {**job, "task": str(task["id"])}
            if task.get("user_status") not in (1, 3):
                raise FarmError("ineligible")
            remaining = task.get("view_duration")
            if not isinstance(remaining, int) or not 1 <= remaining <= 1800:
                raise FarmError("ineligible")
            update("watching", int(task.get("countdown_passed") or 0))
            if not native_playback:
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
