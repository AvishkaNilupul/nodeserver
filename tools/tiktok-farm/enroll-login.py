"""Drive the stock TikTok login UI and pause on account verification."""
import re
import shlex
import subprocess
import time
import xml.etree.ElementTree as ET


class LoginAttention(Exception):
    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)


def nodes(device):
    if getattr(device, 'snapshot_ready', False) is True:
        result = device.adb('exec-out', 'env',
            'CLASSPATH=/data/local/tmp/nodeserver-ui-snapshot.jar:/system/framework/uiautomator.jar',
            'app_process', '/system/bin', 'UiSnapshot', timeout=13)
    else:
        result = device.adb("exec-out", "uiautomator", "dump", "/dev/stdout", timeout=13)
    output = result.stdout
    start, end = output.find(b"<?xml"), output.rfind(b"</hierarchy>")
    if start < 0 or end < start:
        return []
    root = ET.fromstring(output[start:end + len(b"</hierarchy>")])
    return [node.attrib for node in root.iter("node") if node.get("enabled") == "true" and
            node.get("package") == "com.zhiliaoapp.musically"]


def labels(node):
    return {node.get(key, "").strip().casefold() for key in ("text", "content-desc")}


def visible(node):
    coords = list(map(int, re.findall(r"\d+", node.get("bounds", ""))))
    return len(coords) == 4 and coords[2] > coords[0] and coords[3] > coords[1]


def find(items, names, *, button=False):
    matches = [node for node in items if visible(node) and labels(node) & names]
    clickable = next((node for node in matches if node.get("clickable") == "true"), None)
    if clickable:
        return clickable
    if not button:
        return matches[0] if matches else None
    # TikTok exposes some Compose controls through a content description
    # without a clickable flag. Exclude plain headings with the same text.
    return next((node for node in matches if node.get("class", "").endswith(".Button") or
                 node.get("content-desc", "").strip().casefold() in names), None)


def tap(device, node):
    left, top, right, bottom = map(int, re.findall(r"\d+", node["bounds"]))
    device.adb("shell", "input", "tap", str((left + right) // 2), str((top + bottom) // 2))


def type_text(device, node, text):
    if not text.isascii() or any(ord(ch) < 32 or ord(ch) > 126 for ch in text):
        raise LoginAttention("unsupported-input")
    tap(device, node)
    # ADB's input command interprets %s as a space. Split a literal %s across two inputs.
    parts = re.split(r"(?<=%)(?=s)", text)
    commands = ["input text " + shlex.quote(part.replace(" ", "%s")) for part in parts]
    device.adb("shell", "sh", "-s", input=("\n".join(commands) + "\n").encode())


def form_fields(items):
    fields = [node for node in items if node.get("class", "").endswith(".EditText") and visible(node)]
    password = next((node for node in fields if node.get("password") == "true"), None)
    login = next((node for node in fields if node is not password), None)
    return login, password


def challenge(items):
    text = " ".join(label for node in items for label in labels(node)).replace("’", "'")
    return any(phrase in text for phrase in (
        "verify you're human", "verify you are human", "verify to continue", "security verification",
        "verify it's really you", "verify identity",
        "verification code", "enter the code", "check your email", "slide to verify", "captcha",
        "two-step verification", "confirm it's you", "prove you're human",
        "when's your birthdate", "when's your birthday",
    ))


def rejected(items):
    text = " ".join(label for node in items for label in labels(node))
    return any(phrase in text for phrase in ("incorrect password", "password is incorrect",
        "wrong password", "couldn't find this account", "account doesn't exist", "too many attempts"))


def verified_profile(items, username):
    # The newer own-profile screen has a pencil without an Edit Profile label.
    own_profile = find(items, {"edit profile"}) or (
        find(items, {"profile menu"}, button=True) and
        find(items, {"profile views", "profile photo"}, button=True)
    )
    if not own_profile:
        return None
    handles = [node.get("text", "") for node in items if visible(node) and
               re.fullmatch(r"@[a-zA-Z0-9_.]{1,32}", node.get("text", ""))]
    if not handles:
        raise LoginAttention("no-profile")
    if re.fullmatch(r"@?[a-zA-Z0-9_.]+", username):
        expected = username.lstrip("@").casefold()
        matched = next((handle for handle in handles if handle[1:].casefold() == expected), None)
        if not matched:
            raise LoginAttention("login-rejected")
        return matched
    if re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", username):
        return handles[0]
    raise LoginAttention("login-rejected")


def open_profile(device, items):
    if button := find(items, {"profile"}):
        tap(device, button)
        return True
    # This stock app sometimes reports zero bounds for every bottom tab while
    # rendering them normally. Only use the known five-tab layout in that case.
    tabs = {label for node in items if node.get("clickable") == "true" and
            node.get("bounds") == "[0,0][0,0]" for label in labels(node)}
    if not ({"home", "create", "inbox", "profile"} <= tabs and tabs & {"shop", "friends"}):
        return False
    output = device.adb("shell", "wm", "size").stdout.decode("ascii", errors="ignore")
    sizes = re.findall(r"(?:Physical|Override) size: (\d+)x(\d+)", output)
    if not sizes:
        return False
    width, height = map(int, sizes[-1])
    if not (320 <= width <= 2560 and height > width):
        return False
    device.adb("shell", "input", "tap", str(width * 9 // 10), str(height * 97 // 100))
    return True


def sign_in(device, credential, status):
    username, password = credential["username"], credential["password"]
    progress = time.monotonic()
    next_check = progress + 20
    identity_sent = device.state / "identity-attempted"
    password_sent = device.state / "password-attempted"
    entered_username = False
    entered_password = False
    selected_email = False
    next_profile_attempt = 0
    left_signup_birthday = False
    while time.monotonic() - progress < 110:
        if time.monotonic() >= next_check:
            status("signing-in")
            next_check = time.monotonic() + 20
        try:
            items = nodes(device)
        except (subprocess.SubprocessError, ET.ParseError):
            time.sleep(2)
            continue
        if handle := verified_profile(items, username):
            return handle
        if rejected(items):
            raise LoginAttention("login-rejected")
        birthday = find(items, {"when’s your birthdate?", "when's your birthdate?", "when's your birthday?"})
        if not identity_sent.exists() and not password_sent.exists() and not left_signup_birthday and birthday:
            # Existing-account login must not enter the new-account birthday flow.
            left_signup_birthday = True
            device.adb("shell", "input", "keyevent", "4")
            time.sleep(2)
            continue
        if birthday:
            raise LoginAttention('birthdate-required')
        login, secret = form_fields(items)
        email_form = find(items, {"email / username", "email or username"}) and find(items, {"log in"})
        identity_field = login and (labels(login) & {"email or username", "email", "username"} or
                                   email_form and not login.get("text", "").strip())
        if challenge(items) and not secret:
            raise LoginAttention("verification-required")
        if (find(items, {"viewer history", "viewer history turned on"}) and
                find(items, {"bottom sheet"}) and find(items, {"save"}, button=True)):
            # Dismiss the first-profile tutorial without saving a privacy choice.
            device.adb("shell", "input", "keyevent", "4")
            time.sleep(2)
            continue
        # Fresh devices may show optional feed interests after a successful login.
        # Scope Skip to this screen; never dismiss an unknown verification prompt.
        if find(items, {"choose what you like"}) and (button := find(items, {"skip"}, button=True)):
            tap(device, button)
            time.sleep(2)
            continue
        if secret:
            if password_sent.exists():
                time.sleep(3)
                continue
            if identity_field and not entered_username:
                type_text(device, login, username)
                entered_username = True
                time.sleep(1)
                continue
            if not entered_password:
                type_text(device, secret, password)
                entered_password = True
                time.sleep(1)
                continue
            submit = find(items, {"log in", "continue", "next"}, button=True)
            if submit:
                password_sent.touch(mode=0o600, exist_ok=False)
                tap(device, submit)
                time.sleep(5)
                continue
        if button := find(items, {"already have an account? log in"}, button=True):
            tap(device, button)
        elif button := find(items, {"use phone / email / username"}, button=True):
            tap(device, button)
        elif (not selected_email and (not login or labels(login) & {"phone number"}) and
              (button := find(items, {"email / username", "email or username"}, button=True))):
            tap(device, button)
            selected_email = True
        elif button := find(items, {"log in with password", "use password", "enter password"}):
            tap(device, button)
        elif login and not secret and not identity_sent.exists():
            if not entered_username and identity_field:
                type_text(device, login, username)
                entered_username = True
                time.sleep(1)
                continue
            if username.casefold() in labels(login) and (submit := find(items, {"continue", "next"}, button=True)):
                identity_sent.touch(mode=0o600, exist_ok=False)
                tap(device, submit)
                time.sleep(4)
                continue
        elif time.monotonic() >= next_profile_attempt and open_profile(device, items):
            next_profile_attempt = time.monotonic() + 10
        elif button := find(items, {"log in", "log in to tiktok", "already have an account? log in"}, button=True):
            if not password_sent.exists() and not identity_sent.exists():
                tap(device, button)
        time.sleep(2)
    raise LoginAttention("verification-required" if password_sent.exists() or identity_sent.exists() else "unexpected-ui")
