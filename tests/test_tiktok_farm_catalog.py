import runpy
import sys
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch


with patch.dict(sys.modules, {
    "frida": SimpleNamespace(),
    "curl_cffi": SimpleNamespace(CurlOpt=None, requests=None),
    "hpack": SimpleNamespace(HPACKError=ValueError),
}):
    driver = runpy.run_path(str(Path(__file__).resolve().parents[1] / "tools/tiktok-farm/driver.py"))

Driver, FarmError, DETAIL = (driver[name] for name in ("Driver", "FarmError", "DETAIL"))
LIST = "/webcast/partnership/reward/drops_list/v2/"
ROOMS = "/webcast/partnership/reward/drops_page_feed/"


def watch(task, duration, status=1):
    return {"id": task, "type": 5, "view_duration": duration, "user_status": status, "countdown_passed": 0}


def campaign(cid, game, tasks):
    return {"id": cid, "name": "Drop fixture", "game_name": game, "tasks": tasks}


class CatalogTest(unittest.TestCase):
    def setUp(self):
        self.worker = Driver.__new__(Driver)
        self.worker.http_session = lambda **_: nullcontext(None)
        self.worker.get_from_entry = lambda _entry, route, **params: (route, params)

    def test_checks_later_rooms_and_keeps_other_games_and_upcoming(self):
        first, second, third, fourth = watch("11", 3600), watch("22", 180), watch("33", 60), watch("44", 900)
        more = {"id": "12", "type": 4, "view_duration": 0, "user_status": 1}
        active = [
            campaign("1", "Tanks fixture", [{**first, "type": 2}, more]),
            campaign("2", "Clinic fixture", [second]),
            campaign("3", "No stream fixture", [third]),
            campaign("4", "Failed feed fixture", [fourth]),
        ]
        scheduled = {**campaign("5", "Rocket League", []), "start_time": 1794096000}

        def api(_client, request, **_):
            route, args = request
            cid, room = args.get("drops_id"), args.get("room_id")
            status, payload = 0, {}
            if route == LIST:
                payload = {"ongoing_drops_list": [active, active[:1]], "upcoming_drops_list": [scheduled]}
            elif route == ROOMS and cid == "4":
                status = 600
            elif route == ROOMS and cid != "3":
                payload = {"room_list": [{"room_id": n, "anchor_id": 100} for n in ("81", "82", "83")]}
            elif route == DETAIL and cid == "1":
                if room == "81":
                    status = 600
                payload = {"tasks": [first, more] if room == "83" else []}
            elif route == DETAIL and cid == "2":
                payload = {"detail": {"tasks": [second]}}
            return {"business": status, "_payload": {"data": payload}}

        self.worker.mac = Mock(side_effect=api)
        result = self.worker.catalog_from_entry(None, include_upcoming=True)
        self.assertEqual([(e["campaign"], e["room"], e["duration"]) for e in result["events"]],
                         [("2", "81", 180), ("1", "83", 3600)])
        self.assertEqual([(e["game"], e["status"], e["otherTasks"]) for e in result["campaigns"]],
                         [("Tanks fixture", "eligible", True), ("Clinic fixture", "eligible", False),
                          ("No stream fixture", "no-live-room", False), ("Failed feed fixture", "incomplete", False)])
        self.assertEqual(result["campaigns"][0]["watchSeconds"], [3600])
        self.assertTrue(result["partial"])
        self.assertEqual([(e["game"], e["startsAt"]) for e in result["upcoming"]], [("Rocket League", 1794096000000)])

    def test_unknown_shape_is_not_an_empty_success(self):
        self.worker.mac = Mock(return_value={"business": 0, "_payload": {"data": {"unexpected": []}}})
        with self.assertRaises(FarmError):
            self.worker.catalog_from_entry(None, include_upcoming=True)

    def test_claimed_task_completes_check_without_trying_every_room(self):
        claimed = watch("11", 60, status=4)
        fetch = Mock(side_effect=[
            {"room_list": [{"room_id": "81", "anchor_id": "100"}, {"room_id": "82", "anchor_id": "100"}], "has_more": True},
            {"tasks": [claimed]},
        ])
        self.assertEqual(Driver.campaign_events(fetch, "1", "Fixture", [claimed]), ("no-eligible-task", [], False))
        self.assertEqual(fetch.call_count, 2)
