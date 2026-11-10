import importlib.util
import itertools
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

spec=importlib.util.spec_from_file_location('tiktok_login',Path(__file__).resolve().parents[1]/'tools/tiktok-farm/enroll-login.py')
login=importlib.util.module_from_spec(spec);spec.loader.exec_module(login)

def node(text,kind='android.widget.Button',**extra):
    return {'text':text,'class':kind,'bounds':'[0,0][100,50]','enabled':'true','clickable':'true',**extra}

class LoginTests(unittest.TestCase):
    def test_optional_gender_prompt_uses_skip_without_selecting_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            device=Mock();device.state=Path(directory)
            skip=node('Skip',kind='android.widget.TextView',clickable='false')
            screens=[[node('Tell us more about yourself'),node('Prefer not to say'),skip],
                     [node('Edit profile'),node('@fixture')]]
            with patch.object(login,'nodes',side_effect=screens),patch.object(login,'tap') as tap,patch.object(login.time,'sleep'):
                self.assertEqual(login.sign_in(device,{'username':'fixture','password':'fixture-password'},Mock()),'@fixture')
            tap.assert_called_once_with(device,skip)

    def test_offscreen_phone_field_does_not_hide_active_email_field(self):
        hidden=node('Phone number',kind='android.widget.EditText',bounds='[0,537][-60,577]')
        active=node('',kind='android.widget.EditText',bounds='[60,537][660,577]')
        self.assertFalse(login.visible(hidden));self.assertEqual(login.form_fields([hidden,active]),(active,None))

    def test_first_feed_swipe_tutorial_is_dismissed_before_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            device=Mock();device.state=Path(directory)
            screens=[[node('Swipe up for more'),node('Home'),node('Profile',bounds='[576,1196][720,1280]')],
                     [node('Edit profile'),node('@fixture')]]
            with patch.object(login,'nodes',side_effect=screens),patch.object(login.time,'sleep'):
                self.assertEqual(login.sign_in(device,{'username':'fixture','password':'fixture-password'},Mock()),'@fixture')
            device.adb.assert_called_once_with('shell','input','swipe','360','960','360','426','500')

    def test_agreement_pauses_without_accepting_terms(self):
        with tempfile.TemporaryDirectory() as directory:
            device=Mock();device.state=Path(directory)
            with patch.object(login,'nodes',return_value=[node('Agree to our Terms of Service'),node('Agree and continue')]),patch.object(login,'tap') as tap:
                with self.assertRaises(login.LoginAttention) as caught:
                    login.sign_in(device,{'username':'fixture','password':'fixture-password'},Mock())
            self.assertEqual(caught.exception.reason,'agreement-required');tap.assert_not_called();device.adb.assert_not_called()

    def test_birthdate_checks_each_change_and_submits_only_exact_date(self):
        device=Mock();submit=node('Continue')
        def screen(value):
            return [node('When’s your birthdate?'),node('Get more great features? Sign up'),
                    node('To use TikTok, you need to enter your birthdate. This helps us customize your experience.'),
                    node(value,kind='android.widget.EditText'),submit,
                    node('',kind='android.widget.SeekBar',**{'content-desc':'Year picker','bounds':'[480,700][640,970]'}),
                    node('',kind='android.widget.SeekBar',**{'content-desc':'Day picker','bounds':'[280,700][440,970]'})]
        with patch.object(login,'nodes',side_effect=[screen('March 5, 2005'),screen('March 5, 2004'),screen('March 4, 2004')]),patch.object(login,'tap') as tap,patch.object(login.time,'sleep'):
            login.enter_birthdate(device,'2004-03-04',Mock())
        self.assertEqual(device.adb.call_count,2)
        tap.assert_called_once_with(device,submit)

    def test_birthdate_never_submits_invalid_date_or_unrecognized_screen(self):
        for value in ['2001-02-29','2004-2-3','2099-01-01',None,'2004-03-04']:
            with self.subTest(value=value),patch.object(login,'nodes',return_value=[node('When’s your birthdate?'),node('Continue')]),patch.object(login,'tap') as tap:
                device=Mock()
                with self.assertRaises(login.LoginAttention):login.enter_birthdate(device,value,Mock())
                device.adb.assert_not_called();tap.assert_not_called()

    def test_unmoving_birthdate_picker_is_bounded_and_never_submitted(self):
        items=[node('When’s your birthdate?'),node('Get more great features? Sign up'),
               node('To use TikTok, you need to enter your birthdate.'),
               node('March 5, 2005',kind='android.widget.EditText'),node('Continue'),
               node('',kind='android.widget.SeekBar',**{'content-desc':'Year picker','bounds':'[480,700][640,970]'})]
        device=Mock()
        with patch.object(login,'nodes',return_value=items),patch.object(login,'tap') as tap,patch.object(login.time,'sleep'):
            with self.assertRaises(login.LoginAttention):login.enter_birthdate(device,'2004-03-04',Mock())
        self.assertEqual(device.adb.call_count,3);tap.assert_not_called()

    def test_empty_identity_field_on_email_login_is_filled_once(self):
        with tempfile.TemporaryDirectory() as directory:
            device=Mock();device.state=Path(directory)
            field=node('',kind='android.widget.EditText');submit=node('Continue')
            screens=[[node('Log in'),node('Email / Username'),field],
                     [node('Log in'),node('Email / Username'),node('fixture.account',kind='android.widget.EditText'),submit],
                     [node('Enter the code')]]
            with patch.object(login,'nodes',side_effect=screens),patch.object(login,'type_text') as typing,patch.object(login,'tap') as tap,patch.object(login.time,'sleep'):
                with self.assertRaises(login.LoginAttention):
                    login.sign_in(device,{'username':'fixture.account','password':'fixture-pass'},Mock())
            typing.assert_called_once_with(device,field,'fixture.account')
            tap.assert_called_once_with(device,submit)
            self.assertTrue((device.state/'identity-attempted').exists())

    def test_prepared_device_uses_snapshot_reader_and_preserves_real_bounds(self):
        device=Mock();device.snapshot_ready=True
        device.adb.return_value.stdout=b'<?xml version="1.0"?><hierarchy><node text="Profile" class="android.widget.Button" package="com.zhiliaoapp.musically" enabled="true" clickable="true" bounds="[576,1196][720,1280]" /></hierarchy>'
        items=login.nodes(device)
        self.assertEqual(items[0]['bounds'],'[576,1196][720,1280]')
        self.assertIn('UiSnapshot',device.adb.call_args.args)

    def test_legacy_device_retains_stock_reader(self):
        device=Mock();device.snapshot_ready=False;device.adb.return_value.stdout=b'ERROR: could not get idle state.'
        self.assertEqual(login.nodes(device),[])
        device.adb.assert_called_once_with('exec-out','uiautomator','dump','/dev/stdout',timeout=13)

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

    def test_signup_birthday_returns_to_existing_login_before_shared_method_button(self):
        with tempfile.TemporaryDirectory() as directory:
            device=Mock();device.state=Path(directory)
            footer=node('Already have an account? Log in')
            screens=[[node('When’s your birthdate?')],
                     [node('Sign up for TikTok'),node('Use phone / email / username'),footer],
                     [node('Edit profile'),node('@fixture.account')]]
            with patch.object(login,'nodes',side_effect=screens),patch.object(login,'tap') as tap,patch.object(login.time,'sleep'):
                self.assertEqual(login.sign_in(device,{'username':'fixture.account','password':'fixture-pass'},Mock()),'@fixture.account')
            device.adb.assert_called_once_with('shell','input','keyevent','4')
            tap.assert_called_once_with(device,footer)

    def test_required_birthdate_pauses_after_one_back_attempt_without_selecting_a_date(self):
        with tempfile.TemporaryDirectory() as directory:
            device=Mock();device.state=Path(directory)
            with patch.object(login,'nodes',return_value=[node('When’s your birthdate?')]),patch.object(login,'tap') as tap,patch.object(login.time,'sleep'):
                with self.assertRaises(login.LoginAttention) as caught:
                    login.sign_in(device,{'username':'fixture.account','password':'fixture-pass'},Mock())
            self.assertEqual(caught.exception.reason,'birthdate-required')
            device.adb.assert_called_once_with('shell','input','keyevent','4');tap.assert_not_called()

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
            skip=node('Skip',kind='android.widget.TextView',clickable='false');profile=node('Profile')
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

    def test_profile_navigation_retries_when_the_first_tap_is_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            device=Mock();device.state=Path(directory);profile=node('Profile')
            screens=[[profile],[profile],[node('Edit profile'),node('@fixture.account')]]
            with patch.object(login,'nodes',side_effect=screens),patch.object(login,'tap') as tap,patch.object(login.time,'sleep'),patch.object(login.time,'monotonic',side_effect=itertools.count(0,6)):
                result=login.sign_in(device,{'username':'fixture.account','password':'fixture-pass'},Mock())
            self.assertEqual(result,'@fixture.account');self.assertEqual(tap.call_count,2)

if __name__=='__main__':unittest.main()
