import hashlib
import importlib.util
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools/tiktok-farm'))
from reward_metadata import extract


class Metadata(unittest.TestCase):
    def setUp(self):
        self.job = {'campaign': '100', 'task': '200', 'codeHash': hashlib.sha256(b'SYNTHETIC').hexdigest()}
        self.gift = {'gift_code': 'SYNTHETIC', 'need_auth': False, 'end_time': 1796227199,
                     'icon_url': 'https://p19.tiktokcdn.com/reward.webp?x-expires=1794711639',
                     'id_str': '300', 'name': 'Diamonds', 'items': [{'name': 'Diamond', 'count': 10}],
                     'gift_redeem_info': {'gift_redeem_type': 2, 'in_app_steps': 'Pear-Pal > Other > Redeem Code'}}
        self.task = {'id': '200', 'user_status': 4, 'gift': self.gift}
        self.data = {'detail': {'id': '100', 'game_id_str': '400', 'game_name': 'Fixture',
                               'start_time': 1793329200, 'end_time': 1795622399, 'tasks': [self.task]}}

    def test_separate_expiry_and_no_secret_fields(self):
        result = extract(self.data, self.job)
        self.assertEqual(result['useBy'], 1796227199000)
        self.assertNotEqual(result['useBy'], result['campaignEndAt'])
        self.assertNotIn('SYNTHETIC', str(result))
        self.assertEqual(result['items'], [{'name': 'Diamond', 'count': 10}])
        self.assertEqual(result['image'], self.gift['icon_url'])

    def test_no_campaign_date_fallback(self):
        del self.gift['end_time']
        with self.assertRaises(ValueError): extract(self.data, self.job)

    def test_wrong_code_and_task_fail_closed(self):
        self.job['task'] = '201'
        with self.assertRaises(ValueError): extract(self.data, self.job)
        self.job['task'] = '200'; self.gift['gift_code'] = 'OTHER'
        with self.assertRaises(ValueError): extract(self.data, self.job)

    def test_old_auto_task_requires_one_exact_code_match(self):
        self.job['task'] = 'auto'
        self.assertEqual(extract(self.data, self.job)['task'], '200')
        self.data['detail']['tasks'].append(dict(self.task, id='201'))
        with self.assertRaises(ValueError): extract(self.data, self.job)

    def test_unclaimed_or_linked_rewards_are_not_stock(self):
        self.task['user_status'] = 3
        with self.assertRaises(ValueError): extract(self.data, self.job)
        self.task['user_status'] = 4; self.gift['need_auth'] = True
        with self.assertRaises(ValueError): extract(self.data, self.job)


if __name__ == '__main__': unittest.main()
