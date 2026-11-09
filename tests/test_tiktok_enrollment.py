import base64
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock

TOOLS = Path(__file__).resolve().parents[1] / 'tools/tiktok-farm'
sys.path.insert(0, str(TOOLS))
from api_enrollment import install, acknowledge
from api_control import LeaseLost
from session_capture import WireCapture, pack_session, origin_allowed


class Enrollment(unittest.TestCase):
    def test_capture_origin_matches_regional_destinations(self):
        for host in ['webcast16-normal-c-alisg.tiktokv.com','webcast.tiktokv.eu','aggr19-normal.tiktokv.us','tnc16-normal-useast8.tiktokv.us']:
            self.assertTrue(origin_allowed(host),host)
        for host in ['webcast.tiktokv.com.evil.test','evil.tiktokv.com','localhost','webcast.tiktokv.com:443',None]:
            self.assertFalse(origin_allowed(host),host)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.job = {'account': 'tiktok-05', 'lease': 'lease', 'digest': 'a'*64,
                    'packet': {'account':'tiktok-05','server':'https://wrong.test','workerKey':'wrong'}}
        self.template = {'server':'https://control.test','workerKey':'fixture-secret'}
        self.control = Mock()
        self.control.post.return_value = {'ok': True}
        self.verify = Mock()

    def test_install_encrypts_and_activates_only_after_ack(self):
        install(self.root,self.control,self.job,self.template,self.verify)
        state=self.root/'tiktok-05'
        self.assertTrue((state/'activated.json').exists())
        self.assertEqual((state/'session.enc').stat().st_mode & 0o777,0o600)
        self.assertNotIn('fixture-secret',(state/'session.enc').read_text())
        value=json.loads(subprocess.check_output(['node',str(TOOLS/'session-config.cjs'),str(state/'session.enc'),str(state/'session.key')]))
        self.assertEqual(value['server'],self.template['server'])
        self.assertEqual(value['workerKey'],self.template['workerKey'])
        self.assertEqual(self.verify.call_count,1)

    def test_lost_ack_replays_without_replacing_session(self):
        self.control.post.side_effect=OSError('offline')
        with self.assertRaises(OSError):install(self.root,self.control,self.job,self.template,self.verify)
        state=self.root/'tiktok-05';before=(state/'session.enc').read_bytes()
        self.assertFalse((state/'activated.json').exists())
        self.assertTrue((self.root/'enrollment-ack.json').exists())
        self.control.post.side_effect=None
        acknowledge(self.root,self.control)
        self.assertTrue((state/'activated.json').exists());self.assertEqual(before,(state/'session.enc').read_bytes())
        install(self.root,self.control,self.job,self.template,self.verify)
        self.assertEqual(before,(state/'session.enc').read_bytes());self.assertEqual(self.verify.call_count,1)

    def test_existing_slot_is_never_overwritten(self):
        state=self.root/'tiktok-05';state.mkdir();(state/'pending-result.json').write_text('preserve')
        with self.assertRaises(ValueError):install(self.root,self.control,self.job,self.template,self.verify)
        self.assertEqual((state/'pending-result.json').read_text(),'preserve')
        self.verify.assert_not_called();self.control.post.assert_not_called()

    def test_validation_failure_does_not_install(self):
        self.verify.side_effect=ValueError('invalid session')
        with self.assertRaises(ValueError):install(self.root,self.control,self.job,self.template,self.verify)
        self.assertFalse((self.root/'tiktok-05').exists())
        self.control.post.assert_not_called()

    def test_wrong_account_and_traversal_rejected(self):
        for account in ('../other','tiktok-01','tiktok-06'):
            with self.assertRaises(ValueError):install(self.root,self.control,{**self.job,'account':account},self.template,self.verify)
        self.verify.assert_not_called()

    def test_expired_ack_keeps_install_for_new_delivery_lease(self):
        self.control.post.side_effect=LeaseLost('expired')
        install(self.root,self.control,self.job,self.template,self.verify)
        state=self.root/'tiktok-05';before=(state/'session.enc').read_bytes()
        self.assertFalse((state/'activated.json').exists())
        self.control.post.side_effect=None
        install(self.root,self.control,{**self.job,'lease':'replacement'},self.template,self.verify)
        self.assertEqual(before,(state/'session.enc').read_bytes());self.assertTrue((state/'activated.json').exists())


class Capture(unittest.TestCase):
    def test_fragmented_native_handshake_and_masked_entry(self):
        wire=WireCapture();host='webcast-frontier.tiktokv.eu'
        event={'host':host,'direction':'out','connection':'1'}
        head=f'GET /webcast/im/ws_proxy/?aid=1 HTTP/1.1\r\nHost: {host}\r\nCookie: fixture\r\n\r\n'.encode()
        payload=b'fixture-im_enter_room';mask=b'abcd'
        frame=bytes([0x82,0x80|len(payload)])+mask+bytes(c^mask[i%4] for i,c in enumerate(payload))
        for chunk in (head[:20],head[20:]+frame[:5],frame[5:]):wire.feed(event,chunk)
        self.assertTrue(wire.ready())
        seed=('webcast.tiktok.com',[(':path','/webcast/room/enter/')],b'room_id=123&anchor_id=456')
        packet=pack_session('tiktok-05',seed,wire)
        self.assertEqual(packet['seedRoom'],'123');self.assertEqual(base64.b64decode(packet['wire'][0]['frames'][0]),payload)

    def test_foreign_origins_ignored(self):
        wire=WireCapture();wire.feed({'host':'evil.test','direction':'out','connection':'x'},b'private')
        self.assertEqual(wire.connections,{})

if __name__=='__main__': unittest.main()
