"""Authenticated native LIVE presence; no Android runtime or video decoding."""
import gzip
import json
import re
import secrets
import sys
import time
import types
from pathlib import Path
from queue import Queue, Empty
from threading import Thread, Event
from urllib.parse import urlsplit
sys.path.insert(0, str(Path.home()/"tiktok-api-probe/packages"))
import websocket
try:
    import compression.zstd as native_zstd
    class NativeDecoder:
        def __init__(self, dict_data):
            self.dictionary = native_zstd.ZstdDict(dict_data)
        def decompress(self, data, max_output_size):
            decoder = native_zstd.ZstdDecompressor(zstd_dict=self.dictionary)
            result = decoder.decompress(data, max_length=max_output_size+1)
            if len(result)>max_output_size or not decoder.eof:
                raise ValueError("Decoded message too large")
            return result
    zstandard = types.SimpleNamespace(ZstdCompressionDict=lambda data:data, ZstdDecompressor=NativeDecoder)
except ImportError:
    import zstandard
trace_dir = Path(__file__).parent

def varint_read(data, cursor=0):
    value=0
    for shift in range(0,70,7):
        if cursor>=len(data):
            raise ValueError("truncated")
        char=data[cursor];cursor+=1
        value|=(char&127)<<shift
        if char<128:
            return value,cursor
    raise ValueError("varint")

def proto_fields(data):
    cursor=0; result=[]
    while cursor<len(data) and len(result)<600:
        tag,cursor=varint_read(data,cursor)
        key,kind=tag>>3,tag&7
        if key==0:raise ValueError("field0")
        if kind==0:
            value,cursor=varint_read(data,cursor)
        elif kind==2:
            size,cursor=varint_read(data,cursor)
            if cursor+size>len(data):raise ValueError("length")
            value=data[cursor:cursor+size];cursor+=size
        elif kind in (1,5):
            size=8 if kind==1 else 4
            if cursor+size>len(data):raise ValueError("fixed")
            value=data[cursor:cursor+size];cursor+=size
        else:
            raise ValueError("kind")
        result.append((key,kind,value))
    return result

def frame_summary(data):
    try:
        fields=proto_fields(data)
        kind=next((value.decode("ascii") for key,wire,value in fields if key==7 and wire==2),"unknown")
        return kind if re.fullmatch(r"[a-z_]{1,30}",kind) else "unknown"
    except (ValueError,UnicodeError):
        return "unparsed"

class SocketAdapter:
    def __init__(self,socket):
        self.socket=socket
    def send_binary(self,payload,timeout=None):
        self.socket.settimeout(timeout or 4)
        return self.socket.send_binary(payload)
    def recv(self,timeout=None):
        self.socket.settimeout(timeout or 1)
        try:
            payload=self.socket.recv()
        except websocket.WebSocketTimeoutException:
            raise TimeoutError from None
        if not payload:
            raise ConnectionError("Socket closed")
        return (payload.encode() if isinstance(payload,str) else payload),2
    def close(self,timeout=3):
        self.socket.settimeout(timeout)
        self.socket.close()

class SocketSession:
    def __init__(self,**options):
        pass
    def __enter__(self):
        return self
    def __exit__(self,*options):
        return False
    def ws_connect(self,url,headers,timeout=12,**options):
        socket=websocket.create_connection(url,header=[key+": "+value for key,value in headers],
            timeout=timeout,suppress_origin=True)
        return SocketAdapter(socket)

requests=types.SimpleNamespace(Session=SocketSession)

def pb_int(number):
    number=int(number)
    out=bytearray()
    while number>127:
        out.append((number&127)|128)
        number>>=7
    out.append(number)
    return bytes(out)

def pb_pack(fields):
    out=bytearray()
    for key,kind,value in fields:
        out.extend(pb_int((key<<3)|kind))
        if kind==0:
            out.extend(pb_int(value))
        elif kind==2:
            out.extend(pb_int(len(value)));out.extend(value)
        else:
            out.extend(value)
    return bytes(out)

def pb_value(fields,key,default=None):
    return next((value for number,_,value in fields if number==key),default)

def push_packet(kind,payload,log_id=None):
    fields=[(6,2,b"pb"),(7,2,kind.encode()),(8,2,payload)]
    if log_id is not None:
        fields.insert(0,(2,0,log_id))
    return pb_pack(fields)

class NativeSocketProbe:
    def __init__(self,handshake,room):
        self.handshake=handshake
        self.room=room
        self.stop=Event()
        self.commands=Queue()
        self.info={"opened":False,"frames":0,"batches":0,"acks":0,"heartbeats":0,"enters":[]}
        self.info["frameKinds"]=[]
        self.info["observedRooms"]=[]
        self.stage="start"
        dictionary=zstandard.ZstdCompressionDict((trace_dir/"zstd-dictionary-250330.bin").read_bytes())
        self.zstd=zstandard.ZstdDecompressor(dict_data=dictionary)
        self.entry_responses=[]
        self.thread=Thread(target=self.work,daemon=True)

    def entry_packet(self,room):
        template=next(frame for frame in self.handshake["frames"] if frame_summary(frame)=="im_enter_room")
        payload=pb_value(proto_fields(template),8,b"")
        fields=proto_fields(payload)
        updated=[]
        for key,kind,value in fields:
            if key==1:
                value=int(room) if kind==0 else room.encode()
            elif key==8:
                unique=secrets.randbits(62)+1
                value=unique if kind==0 else str(unique).encode()
            updated.append((key,kind,value))
        return push_packet("im_enter_room",pb_pack(updated))

    def work(self):
        row=self.handshake
        hostname=row["host"]
        if (not hostname.startswith("webcast-frontier") or not hostname.endswith((".tiktokv.us",".tiktokv.eu"))
                or urlsplit(row["path"]).path!="/webcast/im/ws_proxy/"):
            self.info["error"]="Native socket origin did not match"
            return
        excluded={"host","connection","upgrade","sec-websocket-key","sec-websocket-version","sec-websocket-extensions",
                  "content-length"}
        headers=[(key,value) for key,value in row["headers"] if key not in excluded]
        try:
            with requests.Session(trust_env=False,default_headers=False) as session:
                self.stage="handshake"
                ws=session.ws_connect("wss://"+hostname+row["path"],headers=headers,timeout=12,
                                      default_headers=False,allow_redirects=False,quote=False)
                try:
                    self.info["opened"]=True
                    current=self.room
                    ws.send_binary(self.entry_packet(current),timeout=4)
                    last_heartbeat=time.monotonic()
                    sequence=1
                    while not self.stop.is_set():
                        try:
                            current=self.commands.get_nowait()
                        except Empty:
                            pass
                        else:
                            self.room=current
                            sequence=1
                            ws.send_binary(self.entry_packet(current),timeout=4)
                            last_heartbeat=time.monotonic()
                        if time.monotonic()-last_heartbeat>=5:
                            ws.send_binary(push_packet("hb",pb_pack([(1,0,int(current)),(2,0,sequence)])),timeout=4)
                            sequence+=1
                            self.info["heartbeats"]+=1
                            last_heartbeat=time.monotonic()
                        try:
                            payload,flags=ws.recv(timeout=1)
                        except Exception as error:
                            if type(error).__name__ in {"WebSocketTimeout","Timeout","TimeoutError"}:
                                continue
                            raise
                        if not payload:
                            continue
                        self.info["frames"]+=1
                        self.stage="decode_frame"

                        fields=proto_fields(payload)
                        kind=pb_value(fields,7,b"").decode("ascii","replace")
                        if len(self.info["frameKinds"])<14:
                            self.info["frameKinds"].append(kind if re.fullmatch(r"[a-z_]{1,32}",kind) else "other")
                        frame_headers={}
                        for key,wire,value in fields:
                            if key==5 and wire==2:
                                header=proto_fields(value)
                                frame_headers[pb_value(header,1,b"")]=pb_value(header,2,b"")
                        response_room=frame_headers.get(b"room_id",b"").decode("ascii","ignore")
                        if re.fullmatch(r"[0-9]{15,22}",response_room) and response_room not in self.info["observedRooms"]:
                            self.info["observedRooms"].append(response_room)
                        body=pb_value(fields,8,b"")
                        if kind=="im_enter_room_resp":
                            self.stage="decode_entry_response"
                            self.entry_responses.append(body)
                            self.info["enters"].append({"expectedRoom":current,"returnedRoom":response_room or None})
                        if kind in {"msg","im_enter_room_resp"}:
                            self.stage="decode_batch"

                            if body.startswith(b"\x1f\x8b"):
                                body=gzip.decompress(body)
                            elif body.startswith(b"\x28\xb5\x2f\xfd"):
                                body=self.zstd.decompress(body,max_output_size=4194304)
                            result=proto_fields(body)
                            self.info["batches"]+=1
                            log_id=pb_value(fields,2)
                            ext=pb_value(result,5,b"")
                            if pb_value(result,9,0) and log_id is not None:
                                ws.send_binary(push_packet("ack",ext,log_id),timeout=4)
                                self.info["acks"]+=1
                finally:
                    ws.close(timeout=3)
        except Exception as error:
            self.info["error"]=type(error).__name__
            self.info["stage"]=self.stage
            if type(error) is ValueError and str(error) in {"truncated","varint","field0","length","fixed","kind"}:
                self.info["parseError"]=str(error)

    def start(self):
        self.thread.start()

    def close(self):
        self.stop.set()
        self.thread.join(5)
