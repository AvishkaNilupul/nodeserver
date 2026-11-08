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
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools/tiktok-farm'))
from api_worker import Worker, build_entry, build_claim, entry_matches
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
        worker.packet = {'seedRoom': '1111111111111111111', 'seedAnchor': '2222222222222222222'}
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


if __name__ == '__main__':
    unittest.main()
