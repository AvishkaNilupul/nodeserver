import base64
import gzip
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from urllib.parse import parse_qs
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools/tiktok-farm'))
from api_worker import Worker, build_entry, build_claim, entry_matches, run_loop, run_fleet, account_loop
from api_client import FarmError, DETAIL
from api_control import process
from native_socket import pb_pack


class ApiWorkerTests(unittest.TestCase):
    def setUp(self):
        self.job = {'id': 'a'*24, 'lease': 'b'*36, 'account': 'tiktok-04',
                    'campaign': '7777777777777777777', 'room': '8888888888888888888',
                    'anchor': '9999999999999999999', 'task': '6666666666666666666'}
        self.read = ('webcast16-normal-no1a.tiktokv.eu', [(':method', 'GET'),
            (':path', DETAIL+'?drops_id='+self.job['campaign']+'&room_id='+self.job['room']+'&anchor_id='+self.job['anchor'])], b'')

    def test_claim_must_match_exact_measured_reward(self):
        with self.assertRaises(FarmError):
            build_claim(self.read, {**self.job, 'room': '1111111111111111111'})
        _, headers, body = build_claim(self.read, self.job)
        self.assertEqual(dict(headers)[':method'], 'POST')
        self.assertEqual(parse_qs(body.decode())['task_id'], [self.job['task']])

    def test_compressed_entry_retargets_without_changing_original(self):
        original = gzip.compress(b'room_id=1111111111111111111&anchor_id=2222222222222222222&other=same')
        seed = (self.read[0], [(':method', 'POST'), (':path', '/webcast/room/enter/')], original)
        _, _, result = build_entry(seed, '1111111111111111111', '2222222222222222222', self.job)
        fields = parse_qs(gzip.decompress(result).decode())
        self.assertEqual(fields['room_id'], [self.job['room']])
        self.assertEqual(fields['anchor_id'], [self.job['anchor']])
        self.assertEqual(fields['other'], ['same'])
        self.assertEqual(seed[2], original)

    def test_binary_entry_must_confirm_both_room_identifiers(self):
        room = pb_pack([(1, 0, int(self.job['room'])), (2, 2, self.job['room'].encode())])
        raw = pb_pack([(2, 2, pb_pack([(1, 2, room)]))])
        self.assertTrue(entry_matches(raw, self.job['room']))
        self.assertFalse(entry_matches(raw, '1111111111111111111'))
        self.assertFalse(entry_matches(b'<html>challenge</html>', self.job['room']))

    def worker(self, state, claim):
        worker = object.__new__(Worker)
        worker.state, worker.stopping = Path(state), threading.Event()
        worker.packet = {'account': 'tiktok-04', 'seedRoom': '1111111111111111111', 'seedAnchor': '2222222222222222222'}
        worker.seed, worker.handshakes = self.read, []
        worker.known_rooms = {}
        worker.status = Mock()
        worker.api = Mock()
        worker.api.get_from_entry.return_value = self.read
        worker.api.read_task.return_value = {'type': 5, 'user_status': 3, 'view_duration': 60, 'countdown_passed': 60}
        worker.api.mac.return_value = claim
        return worker

    def test_uncertain_claim_is_single_attempt_and_goes_to_review_protocol(self):
        with tempfile.TemporaryDirectory() as directory:
            worker = self.worker(directory, {'http': 200, 'business': 0, '_payload': {'data': {}}})
            control = Mock()
            control.post.return_value = {'ok': True}
            pending = Path(directory)/'pending-result.json'
            process(control, self.job, worker.run, None, pending)
            self.assertEqual(worker.api.mac.call_count, 1)
            result = control.post.call_args.args[1]
            self.assertEqual((result['status'], result['phase']), ('failed', 'claim-uncertain'))
            self.assertFalse(pending.exists())

    def test_returned_code_is_durable_before_storage_outage(self):
        with tempfile.TemporaryDirectory() as directory:
            worker = self.worker(directory, {'http': 200, 'business': 0, '_payload': {'data': {'cdkey': 'fixture-code'}}})
            pending = Path(directory)/'pending-result.json'
            control = Mock()
            def post(route, value):
                if value.get('status') == 'completed':
                    self.assertTrue(pending.exists())
                    raise OSError('fixture outage')
                return {'stop': False}
            control.post.side_effect = post
            with self.assertRaises(OSError):
                process(control, self.job, worker.run, None, pending)
            self.assertEqual(json.loads(pending.read_text())['code'], 'fixture-code')
            self.assertEqual(worker.api.mac.call_count, 1)

    def test_expired_lease_prevents_claim(self):
        with tempfile.TemporaryDirectory() as directory:
            worker = self.worker(directory, {})
            update = Mock(side_effect=OSError('fixture lease unavailable'))
            with self.assertRaises(OSError):
                worker.run(None, self.job, update, Mock())
            worker.api.mac.assert_not_called()

    def test_ended_room_recovers_ready_claims_but_never_starts_an_unfinished_watch(self):
        with tempfile.TemporaryDirectory() as directory:
            worker = self.worker(directory, {'business': 0, '_payload': {'data': {'detail': {'tasks': [
                {'id': self.job['task'], 'type': 5, 'user_status': 3, 'view_duration': 300},
                {'id': '5555555555555555555', 'type': 5, 'user_status': 1, 'view_duration': 900},
            ]}}}})
            worker.remember(self.job)
            worker.api.catalog_from_entry.return_value = {'events': [], 'campaigns': [
                {'campaign': self.job['campaign'], 'name': 'Fixture', 'status': 'no-live-room'}],
                'partial': False, 'upcoming': []}
            result = worker.catalog()
            self.assertEqual(len(result['events']), 1)
            self.assertEqual(result['events'][0]['task'], self.job['task'])
            self.assertEqual(result['events'][0]['remaining'], 0)
            self.assertEqual(result['campaigns'][0]['status'], 'eligible')

    def test_historical_claim_recovery_respects_current_eligibility(self):
        with tempfile.TemporaryDirectory() as directory:
            worker = self.worker(directory, {'business': 0, '_payload': {'data': {'can_join': False,
                'tasks': [{'id': self.job['task'], 'type': 5, 'user_status': 3, 'view_duration': 60}]}}})
            worker.remember(self.job)
            worker.api.catalog_from_entry.return_value = {'events': [], 'campaigns': [
                {'campaign': self.job['campaign'], 'name': 'Fixture', 'status': 'no-live-room'}],
                'partial': False, 'upcoming': []}
            self.assertEqual(worker.catalog()['events'], [])

    def test_other_account_job_cannot_use_this_session(self):
        with tempfile.TemporaryDirectory() as directory:
            worker = self.worker(directory, {})
            with self.assertRaises(FarmError):
                worker.run(None, {**self.job, 'account': 'tiktok-03'}, Mock(), Mock())
            worker.api.mac.assert_not_called()

    def test_pending_result_is_recovered_before_polling_only_its_account(self):
        with tempfile.TemporaryDirectory() as directory:
            worker = self.worker(directory, {})
            worker.packet.update(server='https://example.test', workerKey='fixture')
            pending = Path(directory)/'pending-result.json'
            pending.write_text(json.dumps({'id': 'saved-run', 'code': 'fixture-code'}))
            stop = threading.Event()
            control = Mock()
            def post(route, value):
                if route == 'poll':
                    self.assertFalse(pending.exists())
                    self.assertEqual(value['account'], 'tiktok-04')
                    stop.set()
                    return {}
                self.assertEqual(route, 'update')
                self.assertEqual(value['id'], 'saved-run')
                return {'ok': True}
            control.post.side_effect = post
            with patch('api_worker.Control', return_value=control):
                run_loop(worker, stop)
            self.assertEqual([call.args[0] for call in control.post.call_args_list], ['update', 'poll'])

    def test_fleet_keeps_independent_slots_running_concurrently(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for slot in ('tiktok-01', 'tiktok-02', 'tiktok-03', 'tiktok-04'):
                (root/slot).mkdir(mode=0o700)
            barrier = threading.Barrier(4, timeout=3)
            visited = []
            stop = threading.Event()
            def run(state, stopping, lock):
                visited.append(state.name)
                barrier.wait()
                stopping.set()
            with patch('api_worker.account_loop', side_effect=run), patch('api_worker.enrollment_loop', side_effect=lambda root, stop, lock: stop.wait()):
                run_fleet(root, stop)
            self.assertEqual(sorted(visited), ['tiktok-01', 'tiktok-02', 'tiktok-03', 'tiktok-04'])

    def test_newly_activated_slot_joins_without_restarting_existing_threads(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root/'tiktok-01').mkdir()
            pending=root/'tiktok-05';pending.mkdir();(pending/'enrollment.json').write_text('{}')
            stop=threading.Event();visited=[]
            def worker(state, stopping, lock):
                visited.append(state.name)
                if state.name=='tiktok-05':stopping.set()
                else:stopping.wait(12)
            def enroll(root, stopping, lock):
                while 'tiktok-01' not in visited and not stopping.wait(.01):pass
                self.assertNotIn('tiktok-05',visited)
                (pending/'activated.json').write_text('{}')
            with patch('api_worker.account_loop',side_effect=worker), patch('api_worker.enrollment_loop',side_effect=enroll):
                run_fleet(root,stop)
            self.assertEqual(visited,['tiktok-01','tiktok-05'])

    def test_singapore_native_socket_reaches_the_connection_transport(self):
        from native_socket import NativeSocketProbe
        handshake={'host':'webcast-frontier16-normal-alisg.tiktokv.com',
                   'path':'/webcast/im/ws_proxy/?fixture=1','headers':[], 'frames':[]}
        probe=NativeSocketProbe(handshake,'123')
        with patch('native_socket.requests.Session',side_effect=OSError('fixture stop before network')) as transport:
            probe.work()
        transport.assert_called_once()
        self.assertNotEqual(probe.info.get('error'),'Native socket origin did not match')

    def test_wrong_slot_packet_never_starts_a_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)/'tiktok-01'
            stopping = Mock()
            stopping.is_set.side_effect = [False, True]
            with patch('api_worker.load_config', return_value={'account': 'tiktok-02'}), patch('api_worker.Worker') as create:
                account_loop(state, stopping, threading.Lock())
            create.assert_not_called()
            self.assertEqual(json.loads((state/'status.json').read_text())['phase'], 'account-error')


if __name__ == '__main__':
    unittest.main()
