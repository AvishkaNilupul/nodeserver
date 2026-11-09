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

    def test_wrong_signed_in_identity_is_rejected(self):
        with self.assertRaises(login.LoginAttention) as caught:
            login.verified_profile([node('Edit profile'),node('@another.account')],'fixture.account')
        self.assertEqual(caught.exception.reason,'login-rejected')

if __name__=='__main__':unittest.main()
