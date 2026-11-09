"""Install new captured sessions without stopping the running account fleet."""
import json
import logging
import os
from pathlib import Path
import re
import subprocess
import tempfile
from api_control import LeaseLost


def write_private(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def acknowledge(root, control):
    pending = root / 'enrollment-ack.json'
    if not pending.exists():
        return False
    value = json.loads(pending.read_text())
    if not re.fullmatch(r'tiktok-(0[3-9]|[1-9][0-9])', value.get('account', '')):
        raise ValueError('Invalid enrollment acknowledgment')
    try:
        if control.post('enrollment/update', value).get('ok') is not True:
            raise OSError('Enrollment acknowledgment failed')
    except LeaseLost:
        # A new delivery lease will reissue the same digest; retain installed state.
        pending.unlink()
        return False
    write_private(root / value['account'] / 'activated.json', {'digest': value['digest']})
    pending.unlink()
    return True


def install(root, control, job, template, verify):
    account, digest = job.get('account', ''), job.get('digest', '')
    packet = job.get('packet')
    if (not re.fullmatch(r'tiktok-(0[3-9]|[1-9][0-9])', account)
            or not re.fullmatch(r'[a-f0-9]{64}', digest) or not isinstance(packet, dict)
            or packet.get('account') != account):
        raise ValueError('Invalid account enrollment')
    dest = root / account
    installed = False
    if dest.exists():
        marker = dest / 'enrollment.json'
        if not marker.exists() or json.loads(marker.read_text()).get('digest') != digest:
            raise ValueError('Existing account cannot be replaced')
        installed = True
    if not installed:
        # The controller URL and worker credential come from this phone, never a submitted packet.
        packet = {**packet, 'server': template['server'], 'workerKey': template['workerKey']}
        with tempfile.TemporaryDirectory(prefix='.verify-', dir=root) as temporary:
            verify(packet, Path(temporary))
        result = subprocess.run(['node', str(Path(__file__).with_name('session-install.cjs')), str(root)],
            input=json.dumps({'packet': packet, 'digest': digest}).encode(), capture_output=True, timeout=15)
        if result.returncode or json.loads(result.stdout).get('ok') is not True:
            raise OSError('Encrypted installation failed')
    write_private(root / 'enrollment-ack.json', {key: job[key] for key in ('account', 'lease', 'digest')} | {'ok': True})
    acknowledge(root, control)


def run(root, stopping, template, control, verify):
    while not stopping.is_set():
        job = None
        try:
            acknowledge(root, control)
            job = control.post('enrollment/poll', {}).get('job')
            if job:
                install(root, control, job, template, verify)
        except (ValueError, subprocess.SubprocessError) as error:
            logging.warning('Enrollment validation failed: %s', type(error).__name__)
            if job and not (root / 'enrollment-ack.json').exists():
                try:
                    control.post('enrollment/update', {key: job[key] for key in ('account', 'lease', 'digest')} | {'ok': False})
                except (OSError, ValueError, LeaseLost):
                    pass
        except (OSError, LeaseLost):
            # Persisted acknowledgments and delivery leases make a transport retry safe.
            logging.warning('Enrollment control temporarily unavailable')
        except Exception as error:
            logging.warning('Enrollment check failed: %s', type(error).__name__)
            if job and not (root / 'enrollment-ack.json').exists():
                try:
                    control.post('enrollment/update', {key: job[key] for key in ('account', 'lease', 'digest')} | {'ok': False})
                except Exception:
                    pass
        stopping.wait(30)
