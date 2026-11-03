# Phone Firefox residential proxy

The Android claim backup uses its own loopback HTTP proxy on port 8124. It
forwards through the current residential provider with a dedicated Japanese
sticky session. This changes Firefox only. Local bridge requests bypass it;
SOOP and other phone apps keep their existing connections.

Copy `residential-proxy.cjs`, `start-proxy.sh` and `stop-proxy.sh` into the
phone's `~/epic-claim/` directory. Create `residential-proxy.json` there with
`host`, numeric `port`, `username` and `password` from the current protected
proxy configuration, including country/session targeting in the username.
Keep this file mode 600 and outside version control. Do not reuse credentials
from the expired downloaded proxy helper.

Run `./start-proxy.sh` before starting the claim bridge. Run `./stop-proxy.sh`
after stopping the bridge. The installed phone's bridge scripts invoke them
in that order; neither component is started automatically at boot.

Firefox Nightly preferences:

| Preference | Value |
| --- | --- |
| `network.proxy.type` | `1` |
| `network.proxy.http` / `network.proxy.ssl` | `127.0.0.1` |
| `network.proxy.http_port` / `network.proxy.ssl_port` | `8124` |
| `network.proxy.no_proxies_on` | `localhost, 127.0.0.1, ::1` |
| `network.proxy.failover_direct` | `false` |
| `media.peerconnection.enabled` | `false` |

Upstream errors return 502; they never trigger a direct retry. HTTPS is
transported with CONNECT and remains encrypted end to end. The browser's
WebRTC is disabled because this dedicated Firefox profile does not need it.

Verify the browser exit in Firefox, then return to the helper pairing page
by typing its loopback URL in Firefox's address bar. Cross-site navigation to
that page is deliberately refused by the claim bridge.

Rollback: stop the bridge and proxy; restore the original bridge start/stop
scripts from the phone's timestamped backup; clear the listed Firefox user
preferences to restore their defaults. Stop the proxy only after resetting
preferences if Firefox must continue browsing directly. The proxy route does
not change production's chosen claim worker or its rate-limit pause.

Live verification on 2026-11-03: a Japanese browser exit was verified. One
explicitly free game was acquired after completing Epic's visible security
checkbox; ownership was verified through the live library API. A different
exit does not guarantee acceptance or remove visible security checks.
