#!/usr/bin/env python3
"""Run scoped TikTok HTTP calls over a private Termux SSH stream."""
import base64
import json
import os
import subprocess
import sys
from urllib.parse import urlsplit


ROUTES = {
    "/webcast/partnership/reward/drops_list/v2/": "GET",
    "/webcast/partnership/reward/drops_page_feed/": "GET",
    "/webcast/partnership/reward/drops_detail/": "GET",
    "/webcast/partnership/reward/drops_poll/": "GET",
    "/webcast/partnership/reward/drops_claim/": "POST",
    "/webcast/room/enter/": "POST",
}


def quote(value):
    if any(ch in value for ch in "\r\n\0"):
        raise ValueError("Invalid curl value")
    return json.dumps(value, ensure_ascii=False)


def request(req):
    parts = urlsplit(req["url"])
    if (parts.scheme != "https" or not (parts.hostname or "").endswith((".tiktokv.com", ".tiktokv.us", ".tiktok.com"))
            or parts.username or parts.password or parts.port not in (None, 443)
            or ROUTES.get(parts.path) != req["method"]):
        raise ValueError("Unsupported target")
    config = "url = " + quote(req["url"]) + "\n"
    for key, value in req["headers"]:
        config += "header = " + quote(key + ": " + value) + "\n"
    body = base64.b64decode(req["body"], validate=True)
    read_fd, write_fd = os.pipe()
    args = ["curl", "-q", "--silent", "--compressed", "--path-as-is", "--max-time", "12", "--max-filesize", "2000000",
            "--noproxy", "*", "--request", req["method"], "--write-out", "\n%{http_code}",
            "--config", f"/proc/self/fd/{read_fd}"]
    if req["method"] == "POST":
        args.extend(["--data-binary", "@-"])
    with subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          pass_fds=(read_fd,)) as curl:
        os.close(read_fd)
        try:
            with os.fdopen(write_fd, "wb") as config_pipe:
                config_pipe.write(config.encode())
            reply, _ = curl.communicate(body, timeout=15)
        except BaseException:
            curl.kill()
            raise
        if curl.returncode:
            raise OSError("TikTok request failed")
    payload, _, status = reply.rpartition(b"\n")
    return {"http": int(status), "body": base64.b64encode(payload).decode()}


if __name__ == "__main__":
    print('{"ready":true}', flush=True)
    while line := sys.stdin.buffer.readline(2_000_001):
        if len(line) > 2_000_000:
            break
        try:
            print(json.dumps(request(json.loads(line))), flush=True)
        except Exception:
            print('{"error":"request-failed"}', flush=True)
