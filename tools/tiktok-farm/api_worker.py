#!/usr/bin/env python3
"""Run the saved-session TikTok worker in Termux, without an emulator."""
import argparse
import base64
import fcntl
import gzip
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import re
import resource
import signal
import subprocess
import threading
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from api_client import ApiClient, CurlSession, FarmError, DETAIL, POLL, ENTER, CLAIM, public_query
from api_control import Control, LeaseLost, process
from native_socket import NativeSocketProbe, proto_fields, frame_summary


def load_config(state):
    for name in ('session.enc', 'session.key'):
        if (state / name).stat().st_mode & 0o077:
            raise ValueError('Session files must be private')
    result = subprocess.run(['node', str(Path(__file__).with_name('session-config.cjs')),
                             str(state / 'session.enc'), str(state / 'session.key')],
                            capture_output=True, timeout=15, check=True)
    packet = json.loads(result.stdout)
    if not re.fullmatch(r'tiktok-[0-9]{2}', packet.get('account', '')):
        raise ValueError('Invalid account slot')
    return packet


def unpack(value):
    return value['host'], [tuple(row) for row in value['headers']], base64.b64decode(value['body'], validate=True)


def build_entry(seed, seed_room, seed_anchor, job):
    host, headers, raw = seed
    compressed = raw.startswith(b'\x1f\x8b')
    body = gzip.decompress(raw) if compressed else raw
    fields = parse_qsl(body.decode(), keep_blank_values=True)
    if not fields:
        raise FarmError('worker-error')
    sub = {'room_id': job['room'], 'room_id_str': job['room'],
           'anchor_id': job['anchor'], 'anchor_id_str': job['anchor']}
    updated = urlencode([(key, sub.get(key, job['room'] if value == seed_room else
                         job['anchor'] if value == seed_anchor else value)) for key, value in fields]).encode()
    payload = gzip.compress(updated, mtime=0) if compressed else updated
    result = []
    for key, value in headers:
        if key == 'content-length':
            continue
        if key == 'x-ss-stub':
            if value.lower() == hashlib.md5(body).hexdigest():
                value = hashlib.md5(updated).hexdigest().upper()
            elif value.lower() == hashlib.md5(raw).hexdigest():
                value = hashlib.md5(payload).hexdigest().upper()
            else:
                continue
        if key == ':path':
            path = urlsplit(value)
            query = '&'.join(part if part.partition('=')[0] not in sub else
                             part.partition('=')[0]+'='+sub[part.partition('=')[0]] for part in path.query.split('&'))
            value = urlunsplit(path._replace(query=query))
        result.append((key, value))
    return host, result, payload


def entry_matches(raw, expected):
    if raw.startswith(b'\x1f\x8b'):
        raw = gzip.decompress(raw)
    try:
        value = json.loads(raw)
        data = value.get('data') or {}
        room = data.get('room') or data
        return value.get('status_code') == 0 and str(room.get('id_str') or room.get('id')) == expected
    except (ValueError, AttributeError, TypeError):
        pass
    try:
        outer = next(value for key, kind, value in proto_fields(raw) if key == 2 and kind == 2)
        room = next(value for key, kind, value in proto_fields(outer) if key == 1 and kind == 2)
        fields = proto_fields(room)
        ids = {key: str(value) if kind == 0 else value.decode('ascii', 'ignore')
               for key, kind, value in fields if key in (1, 2)}
        return ids.get(1) == expected and ids.get(2) == expected
    except (ValueError, StopIteration, AttributeError):
        return False


def build_claim(read, job):
    host, headers, _ = read
    fields = dict(headers)
    ids = public_query(fields)
    if ids != {'room_id': job['room'], 'drops_id': job['campaign'], 'anchor_id': job['anchor']}:
        raise FarmError('worker-error')
    query = '&'.join(part for part in urlsplit(fields[':path']).query.split('&')
                     if part.partition('=')[0] not in {'drops_id', 'room_id', 'anchor_id', 'user_type'})
    form = urlencode({**ids, 'task_id': job['task'], 'input': '{}'}).encode()
    headers = [(key, value) for key, value in headers
               if key not in {':path', ':method', 'content-type', 'content-length', 'x-ss-stub'}]
    headers.extend([(':path', CLAIM+'?'+query), (':method', 'POST'),
                    ('content-type', 'application/x-www-form-urlencoded; charset=UTF-8')])
    return host, headers, form


class Worker:
    def __init__(self, packet, state, stopping):
        self.packet, self.state, self.stopping = packet, state, stopping
        self.api = ApiClient()
        self.seed = unpack(packet['seed'])
        self.handshakes = []
        for source in packet['wire']:
            row = {**source, 'frames': [base64.b64decode(value, validate=True) for value in source['frames']]}
            if any(frame_summary(frame) == 'im_enter_room' for frame in row['frames']):
                self.handshakes.append(row)
        if not self.handshakes:
            raise ValueError('Native session is incomplete')

    def status(self, phase, **fields):
        value = {'phase': phase, 'account': self.packet['account'], 'pid': os.getpid(),
                 'updatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                 'maxRssKiB': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, **fields}
        temporary = self.state / 'status.tmp'
        temporary.write_text(json.dumps(value))
        temporary.replace(self.state / 'status.json')
        if phase != 'idle':
            logging.info(json.dumps(value))

    def catalog(self):
        self.status('scanning')
        return self.api.catalog_from_entry(self.seed, include_upcoming=True)

    def run(self, _device, job, update, preserve):
        if not all(re.fullmatch(r'[0-9]{1,22}', job.get(key) or '')
                   for key in ('campaign', 'room', 'anchor', 'task')):
            raise FarmError('worker-error')
        client = CurlSession()
        read = self.api.get_from_entry(self.seed, DETAIL, drops_id=job['campaign'],
                                      room_id=job['room'], anchor_id=job['anchor'], user_type=0)
        poll = self.api.get_from_entry(read, POLL, drops_id=job['campaign'],
                                      room_id=job['room'], anchor_id=job['anchor'])
        task = self.api.read_task(client, read, job)
        duration = task.get('view_duration')
        if type(duration) is not int or not 1 <= duration <= 3600 or task.get('user_status') not in (1, 3):
            raise FarmError('ineligible')
        seconds = int(task.get('countdown_passed') or 0)
        update('watching', seconds)
        self.status('watching', run=job['id'], seconds=seconds, duration=duration, initialSeconds=seconds)
        socket = None
        try:
            if task['user_status'] == 1:
                entry = build_entry(self.seed, self.packet['seedRoom'], self.packet['seedAnchor'], job)
                response = self.api.mac(client, entry, refresh=False, unsigned=False,
                                        json_format=False, include_payload=True)
                if response.get('http') != 200 or not entry_matches(response.get('_raw', b''), job['room']):
                    raise FarmError('room-ended')
                socket = NativeSocketProbe(self.handshakes[0], job['room'])
                socket.start()
                started = changed = time.monotonic()
                deadline = started + max(0, duration-seconds) + 120
                reconnects = 0
                while task.get('user_status') == 1:
                    if self.stopping.wait(12):
                        raise FarmError('worker-error')
                    task = self.api.read_task(client, poll, job)
                    current = int(task.get('countdown_passed') or 0)
                    if current > seconds:
                        changed = time.monotonic()
                    seconds = current
                    update('watching', seconds)
                    self.status('watching', run=job['id'], seconds=seconds, duration=duration,
                                socketOpen=socket.info.get('opened'), socketError=socket.info.get('error'),
                                roomConfirmed=job['room'] in socket.info.get('observedRooms', []))
                    if task.get('user_status') == 3:
                        break
                    if time.monotonic() >= deadline or time.monotonic()-changed >= 120:
                        raise FarmError('room-ended')
                    if socket.info.get('error'):
                        if reconnects >= 2:
                            raise FarmError('room-ended')
                        socket.close()
                        socket = NativeSocketProbe(self.handshakes[0], job['room'])
                        socket.start()
                        reconnects += 1
            if task.get('user_status') != 3:
                raise FarmError('ineligible')
            claim = build_claim(read, job)
            update('claiming', seconds)
            self.status('claiming', run=job['id'], seconds=seconds)
            result = self.api.mac(client, claim, include_payload=True, json_format=True)
            code = (result.get('_payload', {}).get('data') or {}).get('cdkey')
            if not isinstance(code, str) or not re.fullmatch(r'[\x21-\x7e]{1,512}', code):
                raise FarmError('claim-uncertain')
            return preserve(code)
        finally:
            if socket:
                socket.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', required=True, type=Path)
    parser.add_argument('--scan', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    args.state.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.state.stat().st_mode & 0o077:
        raise ValueError('State directory must be private')
    stopping = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopping.set())
    signal.signal(signal.SIGINT, lambda *_: stopping.set())
    handler = RotatingFileHandler(args.state / 'worker.log', maxBytes=2_000_000, backupCount=2)
    logging.basicConfig(level=logging.INFO, handlers=[handler])
    with (args.state / 'worker.lock').open('a') as held:
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        packet = load_config(args.state)
        worker = Worker(packet, args.state, stopping)
        (args.state / 'worker.pid').write_text(str(os.getpid()))
        try:
            if args.scan:
                print(json.dumps(worker.catalog()), flush=True)
                return
            control = Control(packet['server'], packet['workerKey'])
            pending = args.state / 'pending-result.json'
            failures = 0
            while not stopping.is_set():
                try:
                    if pending.exists():
                        if control.post('update', json.loads(pending.read_text())).get('ok') is not True:
                            raise OSError('Result storage is not acknowledged')
                        pending.unlink()
                    reply = control.post('poll', {'account': packet['account'], 'scanCapable': True, 'apiRoute': 'phone'})
                    if job := reply.get('job'):
                        process(control, job, worker.run, None, pending)
                        worker.status('job-reported', run=job['id'])
                    elif scan := reply.get('scan'):
                        result = {'account': packet['account'], 'id': scan['id'], 'events': [], 'apiRoute': 'phone'}
                        try:
                            result.update(worker.catalog())
                        except (OSError, ValueError, FarmError) as error:
                            result['error'] = 'session-required' if getattr(error, 'phase', '') == 'session-required' else 'scan-failed'
                            worker.status(result['error'])
                        control.post('catalog', result)
                    else:
                        worker.status('idle')
                    failures = 0
                    stopping.wait(6)
                except (OSError, ValueError, LeaseLost) as error:
                    failures += 1
                    worker.status('storage-pending' if pending.exists() else 'control-unavailable', error=type(error).__name__)
                    stopping.wait(min(60, 5*failures))
        finally:
            worker.status('stopped')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print request values, session contents, codes or exception messages.
        print('TikTok worker stopped: '+type(error).__name__, flush=True)
        raise SystemExit(1)
