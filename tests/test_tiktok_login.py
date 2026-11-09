import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

spec=importlib.util.spec_from_file_location('tiktok_login',Path(__file__).resolve().parents[1]/'tools/tiktok-farm/enroll-login.py')
login=importlib.util.module_from_spec(spec);spec.loader.exec_module(login)

def node(text,kind='android.widget.Button',**extra):
    return {'text':text,'class':kind,'bounds':'[0,0][100,50]','enabled':'true','clickable':'true',**extra}

class LoginTests(unittest.TestCase):
    def test_new_signup_footer_enters_login_without_submitting_signup(self):
        with tempfile.TemporaryDirectory() as directory:
            device=Mock();device.state=Path(directory)
            footer=node('Already have an account? Log in')
            screens=[[node('Sign up for TikTok'),node('Use phone or email'),footer],
                     [node('Edit profile'),node('@fixture.account')]]
            with patch.object(login,'nodes',side_effect=screens),patch.object(login,'tap') as tap,patch.object(login.time,'sleep'):
                result=login.sign_in(device,{'username':'fixture.account','password':'fixture-pass'},Mock())
            self.assertEqual(result,'@fixture.account');tap.assert_called_once_with(device,footer)
            self.assertFalse((device.state/'password-attempted').exists())

    def test_verification_stops_without_clicking_or_typing(self):
        with tempfile.TemporaryDirectory() as directory:
            device=Mock();device.state=Path(directory)
            with patch.object(login,'nodes',return_value=[node('Enter the code')]),patch.object(login,'tap') as tap:
                with self.assertRaises(login.LoginAttention) as caught:
                    login.sign_in(device,{'username':'fixture.account','password':'fixture-pass'},Mock())
            self.assertEqual(caught.exception.reason,'verification-required');tap.assert_not_called()

    def test_optional_interests_are_skipped_before_profile_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            device=Mock();device.state=Path(directory)
            skip=node('Skip');profile=node('Profile')
            screens=[[node('Choose what you like'),skip,node('Next')],
                     [profile],[node('Edit profile'),node('@fixture.account')]]
            with patch.object(login,'nodes',side_effect=screens),patch.object(login,'tap') as tap,patch.object(login.time,'sleep'):
                result=login.sign_in(device,{'username':'fixture.account','password':'fixture-pass'},Mock())
            self.assertEqual(result,'@fixture.account')
            self.assertEqual([call.args[1] for call in tap.call_args_list],[skip,profile])

    def test_skip_does_not_dismiss_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            device=Mock();device.state=Path(directory)
            with patch.object(login,'nodes',return_value=[node('Verify identity'),node('Skip')]),patch.object(login,'tap') as tap:
                with self.assertRaises(login.LoginAttention) as caught:
                    login.sign_in(device,{'username':'fixture.account','password':'fixture-pass'},Mock())
            self.assertEqual(caught.exception.reason,'verification-required');tap.assert_not_called()

    def test_wrong_signed_in_identity_is_rejected(self):
        with self.assertRaises(login.LoginAttention) as caught:
            login.verified_profile([node('Edit profile'),node('@another.account')],'fixture.account')
        self.assertEqual(caught.exception.reason,'login-rejected')

    def test_zero_bounds_navigation_uses_current_screen_override(self):
        for second_tab in ['Shop','Friends']:
            with self.subTest(second_tab=second_tab):
                device=Mock();device.adb.return_value.stdout=b'Physical size: 1080x1920\nOverride size: 720x1280\n'
                tabs=[node(name,bounds='[0,0][0,0]') for name in ['Home',second_tab,'Create','Inbox','Profile']]
                self.assertTrue(login.open_profile(device,tabs))
                device.adb.assert_called_with('shell','input','tap','648','1241')

    def test_zero_bounds_profile_alone_does_not_use_coordinates(self):
        device=Mock()
        self.assertFalse(login.open_profile(device,[node('Profile',bounds='[0,0][0,0]')]))
        device.adb.assert_not_called()

    def test_profile_tutorial_is_dismissed_without_saving_preferences(self):
        with tempfile.TemporaryDirectory() as directory:
            device=Mock();device.state=Path(directory)
            screens=[[node('Viewer history'),node('Bottom sheet'),node('Save')],
                     [node('Edit profile'),node('@fixture.account')]]
            with patch.object(login,'nodes',side_effect=screens),patch.object(login,'tap') as tap,patch.object(login.time,'sleep'):
                result=login.sign_in(device,{'username':'fixture.account','password':'fixture-pass'},Mock())
            self.assertEqual(result,'@fixture.account');tap.assert_not_called()
            device.adb.assert_called_once_with('shell','input','keyevent','4')

if __name__=='__main__':unittest.main()
