"""Bounded native-session capture; credentials remain in memory until encrypted upload."""
import base64
import gzip
import re
from urllib.parse import parse_qsl, urlsplit


class WireCapture:
    def __init__(self):
        self.connections = {}
        self.handshakes = []

    def feed(self, event, chunk):
        host = event.get('host', '')
        if event.get('direction') != 'out' or not re.fullmatch(r'webcast-frontier[a-z0-9-]*\.(?:tiktokv\.com|tiktokv\.us|tiktokv\.eu)', host):
            return
        key = event.get('connection')
        if key not in self.connections and len(self.connections) >= 20:
            return
        state = self.connections.setdefault(key, {'data': bytearray(), 'http': None, 'count': 0})
        data = state['data']
        if len(data) + len(chunk) > 65536:
            state['http'] = False
            data.clear()
            return
        data.extend(chunk)
        if state['http'] is None and b'\r\n\r\n' in data:
            head, _, tail = bytes(data).partition(b'\r\n\r\n')
            lines = head.split(b'\r\n')
            if not lines[0].startswith(b'GET /webcast/im/ws_proxy/?'):
                state['http'] = False
                data.clear()
                return
            headers = []
            for line in lines[1:]:
                name, sep, value = line.partition(b':')
                if sep:
                    headers.append((name.decode('ascii').lower(), value.strip().decode('latin1')))
            if dict(headers).get('host', host).split(':')[0] != host:
                state['http'] = False
                return
            row = {'host': host, 'path': lines[0].decode('ascii').split(' ')[1], 'headers': headers, 'frames': []}
            self.handshakes.append(row)
            state.update(http=True, handshake=row)
            data[:] = tail
        if state['http'] is not True:
            return
        while len(data) >= 2 and state['count'] < 24:
            opcode, length, masked, offset = data[0] & 15, data[1] & 127, bool(data[1] & 128), 2
            if length in (126, 127):
                size = 2 if length == 126 else 8
                if len(data) < 2 + size:
                    return
                length, offset = int.from_bytes(data[2:2+size], 'big'), 2+size
            if length > 65536:
                state['http'] = False
                data.clear()
                return
            if masked:
                if len(data) < offset+4:
                    return
                mask = bytes(data[offset:offset+4]); offset += 4
            if len(data) < offset+length:
                return
            payload = bytes(data[offset:offset+length]); del data[:offset+length]
            if masked:
                payload = bytes(value ^ mask[i % 4] for i, value in enumerate(payload))
            state['count'] += 1
            # The native entry template is the only frame needed for subsequent rooms.
            if opcode == 2 and b'im_enter_room' in payload and len(payload) <= 16000:
                state['handshake']['frames'] = [payload]

    def ready(self):
        return any(row['frames'] for row in self.handshakes)


def pack_session(account, seed, wire):
    host, headers, raw = seed
    body = gzip.decompress(raw) if raw.startswith(b'\x1f\x8b') else raw
    fields = dict(parse_qsl(body.decode()))
    query = dict(parse_qsl(urlsplit(dict(headers)[':path']).query))
    room = fields.get('room_id') or fields.get('room_id_str') or query.get('room_id')
    anchor = fields.get('anchor_id') or fields.get('anchor_id_str') or query.get('anchor_id') or '0'
    if not all(re.fullmatch(r'[0-9]{1,22}', value or '') for value in (room, anchor)):
        raise ValueError('Captured room identity missing')
    rows = [{**row, 'frames': [base64.b64encode(frame).decode() for frame in row['frames']]}
            for row in wire.handshakes if row['frames']][:1]
    if not rows:
        raise ValueError('Native entry missing')
    return {'account': account, 'seedRoom': room, 'seedAnchor': anchor,
            'seed': {'host': host, 'headers': headers, 'body': base64.b64encode(raw).decode()}, 'wire': rows}
