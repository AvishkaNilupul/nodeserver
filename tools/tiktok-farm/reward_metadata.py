"""Read the issued reward's dates and items without claiming or redeeming it."""
import hashlib
import re
from api_client import DETAIL, CurlSession, FarmError


def extract(detail, job):
    data = detail.get('detail') or detail
    if str(data.get('id') or '') != job['campaign']:
        raise ValueError('Campaign mismatch')
    candidates = []
    for task in data.get('tasks') or []:
        gift = task.get('gift') or {}
        code = gift.get('gift_code')
        if (not isinstance(code, str) or not code or
                hashlib.sha256(code.encode()).hexdigest() != job['codeHash']):
            continue
        tid = str(task.get('id') or '')
        if job['task'] != 'auto' and tid != job['task']:
            continue
        if not re.fullmatch(r'\d{1,22}', tid) or task.get('user_status') != 4 or gift.get('need_auth') is not False:
            continue
        redeem = gift.get('gift_redeem_info') or {}
        # These are separate native fields: gift.end_time is the redemption
        # deadline; detail.end_time is only the event's end.
        def stamp(value):
            if type(value) is not int or not 946684800 <= value < 4102444800:
                raise ValueError('Missing explicit redemption date')
            return value * 1000
        candidates.append({
            'campaign': job['campaign'], 'task': tid,
            'gameId': str(data.get('game_id_str') or data.get('game_id') or ''),
            'gameName': data.get('game_name'), 'giftId': str(gift.get('id_str') or ''),
            'name': gift.get('name'), 'needAuth': False,
            'campaignStartAt': stamp(data.get('start_time')), 'campaignEndAt': stamp(data.get('end_time')),
            'useBy': stamp(gift.get('end_time')), 'redeemType': redeem.get('gift_redeem_type'),
            'redeemUrl': redeem.get('link') or '',
            'instructions': redeem.get('in_app_steps') or redeem.get('extra') or '',
            'items': [{'name': i.get('name'), 'count': i.get('count')} for i in gift.get('items') or []],
        })
    if len(candidates) != 1:
        raise ValueError('Issued code did not identify exactly one reward')
    return candidates[0]


def read(api, seed, job):
    request = api.get_from_entry(seed, DETAIL, drops_id=job['campaign'],
                                 room_id=job['room'], anchor_id=job.get('anchor') or '0', user_type=0)
    result = api.mac(CurlSession(), request, include_payload=True, json_format=True)
    if result.get('business') != 0:
        raise FarmError('reward-read-failed')
    return extract(result['_payload'].get('data') or {}, job)
