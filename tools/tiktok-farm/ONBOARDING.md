# Mac account setup

The setup agent uses `enroll-device.py` and `enroll-login.py` to sign into an isolated
Android instance, verify the account profile, and capture a native session for the
phone worker. Verification prompts require completion before Resume.

The dashboard accepts up to 20 logins in **Add multiple accounts**, one
`username:password` per line. Four-field account lines are accepted, but the linked
mailbox credentials are discarded before requests are sent. Every line is checked
before submission; partial submission reports exactly which slots were confirmed.

Setup reports its available device capacity to the controller. An open verification
window holds that capacity, while later accounts remain queued. Resume can reclaim
the same device without making the other queued accounts fail. Birthday screens
pause for the required information; the worker never invents a birthdate.

New temporary Android devices are marked for cleanup. After the phone acknowledges
installation and the controller removes the encrypted handoff, it can authorize
cleanup for the matching account and credential version. Only a marked, stopped
device is removed. Previously created devices are retained, as are phone sessions,
saved encrypted logins, reward codes and local setup logs. Low disk space pauses
new device allocation while acknowledgments and cleanup continue.

Build the screen reader with an installed JDK and Android SDK build tools:

```sh
python3 tools/tiktok-farm/build-ui-snapshot.py --output /path/to/private/farm-runtime/ui-snapshot.jar
```

Deploy the generated jar beside `enroll-device.py`, along with the setup Python
sources. The device installer copies it into its temporary Android instance.
The generated jar is a private runtime build artifact, not a checked-in binary.

`UiSnapshot.java` reads the accessibility tree through Android's existing
UI Automator bridge. It does not wait for the animated feed to become idle, and
preserves the native element bounds. Password fields are omitted from the XML;
the snapshot travels through process output in memory and must not be logged.
Older installations without this jar retain the stock reader, which can fail on
continuously animated screens.

The standard dump command's idle wait is documented in
[AOSP DumpCommand](https://android.googlesource.com/platform/frameworks/uiautomator/+/17fac436d78f6ac642386a245fb4fdb7243a91a4/cmds/uiautomator/src/com/android/commands/uiautomator/DumpCommand.java).
The bridge follows Android's existing
[UiAutomationShellWrapper](https://android.googlesource.com/platform/frameworks/testing/+/89f6117/uiautomator/library/src/com/android/uiautomator/core/UiAutomationShellWrapper.java).

After changing the setup reader, verify profile matching, challenge pauses, and
the real device flow. Never publish a session before the phone validates it.
