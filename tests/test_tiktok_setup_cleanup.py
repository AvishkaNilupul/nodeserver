import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('setup_device', Path(__file__).resolve().parents[1] / 'tools/tiktok-farm/enroll-device.py')
device_tools = importlib.util.module_from_spec(spec)
spec.loader.exec_module(device_tools)


class SetupCleanup(unittest.TestCase):
    def test_only_marked_stopped_device_is_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);avds=root/'avds';avds.mkdir();state=root/'state';state.mkdir()
            own=avds/'tiktok-06-managed.avd';own.mkdir();(own/'private-device-data').write_text('fixture')
            other=avds/'tiktok-05-managed.avd';other.mkdir();(other/'preserve').touch()
            (avds/'tiktok-06-managed.ini').touch()
            device=object.__new__(device_tools.Device);device.name='tiktok-06-managed';device.state=state
            rows={device.name:{'port':5576},'tiktok-05-managed':{'port':5574}}
            active=Mock(return_value=False);save=Mock()
            device.pilot={'AVDS':avds,'records':lambda:dict(rows),'is_active':active,'save':save}
            with patch.object(device_tools,'ROOT',root):
                self.assertFalse(device.cleanup());self.assertTrue(own.exists())
                (state/'temporary-device').touch();(state/'handoff-pending.json').write_text('{}')
                active.return_value=True
                self.assertFalse(device.cleanup());self.assertTrue(own.exists())
                active.return_value=False
                self.assertTrue(device.cleanup())
            self.assertFalse(own.exists());self.assertTrue((other/'preserve').exists())
            self.assertFalse((state/'handoff-pending.json').exists())
            self.assertNotIn(device.name,save.call_args.args[0])
            self.assertIn('tiktok-05-managed',save.call_args.args[0])

    def test_symlink_cannot_redirect_cleanup_to_another_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);avds=root/'avds';avds.mkdir();other=root/'preserve';other.mkdir()
            state=root/'state';state.mkdir();(state/'temporary-device').touch()
            (avds/'tiktok-06-managed.avd').symlink_to(other,target_is_directory=True)
            device=object.__new__(device_tools.Device);device.name='tiktok-06-managed';device.state=state
            device.pilot={'AVDS':avds,'records':lambda:{},'save':Mock()}
            with patch.object(device_tools,'ROOT',root), self.assertRaises(device_tools.SetupError):device.cleanup()
            self.assertTrue(other.exists())

if __name__=='__main__':unittest.main()
