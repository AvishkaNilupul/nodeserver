"""Emulator-free reward reads using the proven native request context."""
import base64
import gzip
import re
import sys
import time
import runpy
from pathlib import Path
from contextlib import contextmanager
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

DETAIL = "/webcast/partnership/reward/drops_detail/"
POLL = "/webcast/partnership/reward/drops_poll/"
ENTER = "/webcast/room/enter/"
CLAIM = "/webcast/partnership/reward/drops_claim/"
MAX_WATCH_SECONDS = 3600
CATALOG_LIMIT = 100
CATALOG_READ_SECONDS = 150
SIGNING = {"x-argus", "x-gorgon", "x-khronos", "x-ladon"}
REWARD = re.compile(r"^/webcast/partnership/reward/drops_(detail|poll|list/v2|page_feed)/$")
WATCH_POSTS = {ENTER}
bridge_request = runpy.run_path(str(Path(__file__).with_name("phone-bridge.py")))["request"]

def origin_allowed(host):
    return bool(re.fullmatch(r"(?:webcast[a-z0-9-]*|aggr[0-9]+-normal|tnc[a-z0-9-]*|cp-rp[a-z0-9-]*|web-ttp2\.us)\.(?:tiktokv?\.com|tiktokv\.us|tiktokv\.eu)", host or ""))

class Response:
    def __init__(self, reply):
        self.status_code = reply["http"]
        self.content = base64.b64decode(reply["body"], validate=True)
        self.headers = {}
    def json(self):
        import json
        return json.loads(self.content)

class CurlSession:
    def request(self, method, url, *, data=None, headers=(), **options):
        return Response(bridge_request({"url":url, "method":method, "headers":headers,
                        "body":base64.b64encode(data or b"").decode()}))
    def close(self):
        pass

import json

def summarize_payload(raw):
    try:
        if raw.startswith(b"\x1f\x8b"):
            raw = gzip.decompress(raw)
        obj = json.loads(raw)
        data = obj.get("data") or {}
        tasks = data.get("tasks") or (data.get("detail") or {}).get("tasks") or []
        return {"business": obj.get("status_code"),
                "tasks": [{k: task[k] for k in ("user_status", "user_view_duration", "view_duration",
                                             "type", "countdown_passed") if k in task}
                          for task in tasks]}
    except (AttributeError, ValueError, TypeError, OSError):
        return {"business": None, "tasks": []}

def clean_route(headers):
    fields = dict(headers)
    path = fields.get(":path", "")
    return urlsplit(path).path, fields

def mac_request(client, entry, *, unsigned=True, refresh=True, json_format=False, include_payload=False):
    host, headers, body = entry
    route, fields = clean_route(headers)
    path = fields.get(":path", "")
    authority = fields.get(":authority")
    method = fields.get(":method")
    if not origin_allowed(host) or not origin_allowed(authority):
        return {"allowed_host": False}
    if method not in ("GET", "POST") or not (REWARD.fullmatch(route) or route in WATCH_POSTS or route == CLAIM):
        return {"allowed_path": False}
    if any(key.startswith("x-unknown-index-") for key, _ in headers):
        return {"complete_headers": False}
    now = int(time.time() * 1000)
    if refresh:
        path = re.sub(r"([?&]ts=)\d+", rf"\g<1>{now // 1000}", path)
        path = re.sub(r"([?&]_rticket=)\d+", rf"\g<1>{now}", path)
    regular = []
    for key, value in headers:
        if key.startswith(":") or key in {"content-length", "accept-encoding"} or unsigned and key in SIGNING:
            continue
        if json_format and key == "response-format":
            value = "json"
        if refresh and key == "x-ss-req-ticket":
            value = str(now)
        regular.append((key, value))
    if authority != host:
        regular.insert(0, ("host", authority))
    try:
        response = client.request(method, f"https://{host}{path}", data=body or None,
                                  headers=regular, allow_redirects=False, quote=False, timeout=10)
        result = {"http":response.status_code, "body_bytes":len(response.content),
                  "content_type":response.headers.get("content-type"),
                  **summarize_payload(response.content)}
        if include_payload:
            result["_raw"] = response.content
        if include_payload and result["business"] == 0:
            result["_payload"] = response.json()
        return result
    except OSError as error:
        return {"transport_error": type(error).__name__}

def android_room(entry):
    _, headers, body = entry
    fields = dict(headers)
    for source in (urlsplit(fields.get(":path", "")).query, body.decode("ascii", errors="ignore")):
        params = parse_qs(source)
        for key in ("room_id", "room_id_str"):
            value = params.get(key, [""])[0]
            if re.fullmatch(r"[0-9]{16,22}", value):
                return value
    return None

def public_query(fields):
    params = parse_qs(urlsplit(fields.get(":path", "")).query)
    return {k: params[k][0] for k in ("drops_id", "room_id", "anchor_id")
            if k in params and re.fullmatch(r"[0-9]{16,22}", params[k][0])}

def catalog_rows(value):
    rows = {}

    def collect(item):
        if isinstance(item, dict):
            name = item.get("drops_name") or item.get("name") or item.get("title")
            cid = str(item.get("drops_id") or item.get("id") or "")
            if (isinstance(name, str) and name.strip() and re.fullmatch(r"[0-9]{1,22}", cid)
                    and any(key in item for key in ("drops_id", "game_name", "end_time"))):
                rows[cid] = (name.strip()[:100], item)
                return
            for child in item.values():
                collect(child)
        elif isinstance(item, list):
            for child in item:
                collect(child)

    collect(value)
    return rows

def catalog_event(campaign, name, row):
    def timestamp(value):
        if isinstance(value, str) and value.isdecimal() and len(value) <= 13:
            value = int(value)
        if type(value) is not int:
            return None
        millis = value * 1000 if value < 10_000_000_000 else value
        return millis if 946684800000 <= millis < 4102444800000 else None

    game = row.get("game_name")
    return {"campaign": campaign, "name": name, "game": game.strip()[:100] if isinstance(game, str) else "",
            "startsAt": timestamp(row.get("start_time")), "endsAt": timestamp(row.get("end_time"))}

class FarmError(Exception):
    def __init__(self, phase):
        super().__init__(phase)
        self.phase = phase

class ApiClient:
    def __init__(self):
        self.trace = {"mac_request":mac_request}
        self.api_route = "phone"
        self.api_origins = {}

    @contextmanager
    def http_session(self, **options):
        yield CurlSession()

    def mac(self, client, capture, **options):
        host, headers, body = capture
        fields = dict(headers)
        coalesced = host in {"aggr16-normal.tiktokv.us", "aggr19-normal.tiktokv.us"}
        regional = "tnc16-normal-useast8.tiktokv.us" if coalesced else host
        origin_key = (self.api_route, host, fields.get(":authority"))
        selected = self.api_origins.get(origin_key, regional)
        if options.get("json_format") and not any(key == "response-format" for key, _ in headers):
            headers = [*headers, ("response-format", "json")]
        result = self.trace["mac_request"](client, (selected, headers, body), **options)
        if coalesced and fields.get(":method") == "GET":
            if result.get("business") != 0:
                alternate = host if selected == regional else regional
                retry = self.trace["mac_request"](client, (alternate, headers, body), **options)
                if retry.get("business") == 0:
                    self.api_origins[origin_key] = alternate
                    return retry
            else:
                self.api_origins[origin_key] = selected
        return result

    def read_task(self, client, read, job):
        result = self.mac(client, read, include_payload=True, json_format=True)
        if result.get("business") != 0:
            print(f"TikTok reward read HTTP {result.get('http')}, status {result.get('business')}",
                  file=sys.stderr, flush=True)
            raise FarmError("session-required" if (result.get("http") == 401 or result.get("business") == 20003) else "reward-read-failed")
        data = result["_payload"].get("data") or {}
        if data.get("can_join") is False:
            raise FarmError("ineligible")
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

    def catalog_from_entry(self, entry, *, include_upcoming=False, use_phone=True, deadline=None):
        deadline = deadline or time.monotonic() + CATALOG_READ_SECONDS
        with self.http_session(use_phone=use_phone) as client:
            def fetch(route, **params):
                if time.monotonic() >= deadline:
                    raise FarmError("catalog-deadline")
                result = self.mac(client, self.get_from_entry(entry, route, **params),
                                  include_payload=True, json_format=True)
                if result.get("business") != 0:
                    raise FarmError("session-required" if (result.get("http") == 401 or result.get("business") == 20003) else "reward-read-failed")
                return result["_payload"].get("data") or {}

            prefix = "/webcast/partnership/reward/"
            data = fetch(prefix + "drops_list/v2/")
            if not any(key in data for key in ("ongoing_drops_list", "current_drops", "upcoming_drops_list", "ended_drops_list")):
                raise FarmError("reward-read-failed")
            campaigns = catalog_rows([data.get("ongoing_drops_list"), data.get("current_drops")])
            upcoming = catalog_rows(data.get("upcoming_drops_list"))
            partial = max(len(campaigns), len(upcoming)) > CATALOG_LIMIT
            events, active = [], []
            for cid, (name, row) in list(campaigns.items())[:CATALOG_LIMIT]:
                advertised = row.get("tasks") or []
                info = catalog_event(cid, name, row)
                status, candidates, other_tasks = self.campaign_events(fetch, cid, name, advertised)
                durations = {task["view_duration"] for task in advertised if task.get("type") in (2, 5)
                             and type(task.get("view_duration")) is int and 1 <= task["view_duration"] <= 86400}
                durations.update(event["duration"] for event in candidates)
                active.append({**info, "status": status, "otherTasks": other_tasks,
                               "watchSeconds": sorted(durations)[:20]})
                partial |= status == "incomplete"
                events.extend({**event, "endsAt": info["endsAt"]} for event in candidates)
            events.sort(key=lambda event: (event["remaining"], event["duration"], event["campaign"]))
            if not include_upcoming:
                return events[:CATALOG_LIMIT]
            return {"events": events[:CATALOG_LIMIT], "campaigns": active, "partial": partial or len(events) > CATALOG_LIMIT,
                    "upcoming": [catalog_event(cid, name, row) for cid, (name, row) in list(upcoming.items())[:CATALOG_LIMIT]]}

    @staticmethod
    def campaign_events(fetch, campaign, name, advertised):
        def task_id(task):
            value = str(task.get("id") or task.get("id_str") or "")
            return value if re.fullmatch(r"[0-9]{1,22}", value) else None

        def other_type(task, watch_types):
            duration = task.get("view_duration")
            return (task.get("type") not in watch_types or (task.get("gift") or {}).get("need_auth")
                    or type(duration) is int and not 1 <= duration <= MAX_WATCH_SECONDS)

        # The catalog labels some countdowns as type 2. Room detail uses type 5.
        expected = {task_id(task) for task in advertised if not other_type(task, (2, 5))} - {None}
        other_tasks = any(other_type(task, (2, 5)) for task in advertised)
        candidates, resolved = {}, set()
        saw_tasks = False
        try:
            feed = fetch("/webcast/partnership/reward/drops_page_feed/", drops_id=campaign, is_refresh="true")
        except (OSError, ValueError, FarmError):
            return "incomplete", [], other_tasks
        rooms = feed.get("room_list") or []
        if not rooms:
            return ("incomplete" if feed.get("has_more") else "no-live-room"), [], other_tasks
        seen_rooms = set()
        for room in rooms:
            rid, aid = str(room.get("room_id", "")), str(room.get("anchor_id", ""))
            if rid in seen_rooms or not all(re.fullmatch(r"[0-9]{1,22}", value) for value in (rid, aid)):
                continue
            seen_rooms.add(rid)
            try:
                detail = fetch(DETAIL, drops_id=campaign, room_id=rid, anchor_id=aid, user_type=0)
            except FarmError as error:
                if error.phase in ("catalog-deadline", "session-required"):
                    break
                continue
            except (OSError, ValueError):
                continue
            tasks = detail.get("tasks") or (detail.get("detail") or {}).get("tasks") or []
            saw_tasks |= bool(tasks)
            other_tasks |= any(other_type(task, (5,)) for task in tasks)
            for task in tasks:
                tid, duration, status = task_id(task), task.get("view_duration"), task.get("user_status")
                if not tid or other_type(task, (5,)) or type(duration) is not int or status not in (0, 1, 2, 3, 4):
                    continue
                resolved.add(tid)
                if status not in (1, 3):
                    continue
                seconds = task.get("countdown_passed")
                seconds = min(duration, max(0, seconds)) if type(seconds) is int else 0
                remaining = 0 if status == 3 else duration - seconds
                if tid not in candidates or remaining < candidates[tid]["remaining"]:
                    candidates[tid] = {"campaign": campaign, "name": name, "room": rid, "anchor": aid,
                                       "task": tid, "duration": duration, "remaining": remaining}
            # Detail is campaign-wide once it includes every advertised watch task.
            if expected and expected <= resolved:
                break
        if expected - resolved or not saw_tasks:
            return "incomplete", list(candidates.values()), other_tasks
        if not expected and feed.get("has_more"):
            return "incomplete", list(candidates.values()), other_tasks
        return ("eligible" if candidates else "no-eligible-task"), list(candidates.values()), other_tasks
