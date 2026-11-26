# Fourth USA browser relay

Owner rule: all fourth account Twitch connections must use USA egress. This applies to OAuth device/token/validation/refresh, Helix, EventSub initial and reconnect sockets. The fourth helper makes no external Twitch connections itself. The original three helpers, loopback coordinator and mail service are unchanged.

The fourth Chrome extension service worker performs bounded, fixed Twitch requests through the profile's Nord USA route. Immediately before each operation it obtains `https://www.cloudflare.com/cdn-cgi/trace` with credentials omitted, no cache and redirects rejected; only a fresh `loc=US` and valid IP proof allows submission. A five-second proof lifetime also bounds active socket presence; a fifteen-second browser lease expires independently. Nord USA connection and kill switch must remain enabled. This route needs no Nord service credentials and no Node proxy dependency.

Persisted OAuth credentials stay in the helper's private files. Bounded authorization headers, OAuth forms, and responses pass ephemerally through the paired browser worker, never browser storage or logs. All relay state, deduplication, proofs and in-flight bodies are memory only. No setup or module import performs network activity.

## Paired wire protocol

All four routes are POST under `/api/usa-transport/`. They require the existing exact loopback Host, paired `chrome-extension://` Origin and Bearer pairing token. They are absent from the public host gateway. Errors contain fixed diagnostics only.

- `poll`: `{sessionId,epoch?,proof:null|{ip,loc:'US',checkedAt}}` returns `{ok:true,epoch,leaseExpiresAt,needsProof,job:null|{id,kind,expiresAt,...}}`. A new worker session retires the previous session for sixty seconds (longer than every in-flight deadline); a changed helper epoch fences old work. A job is issued once and never redelivered, including after a lost poll response. Poll with a stale epoch resynchronizes without issuing a job.
- `begin`: `{sessionId,epoch,id,proof}` returns `{ok:true,expiresAt}` once. It checks the operation deadline, browser lease, fresh USA proof, captured Twitch generation and LocalControl generation. Cleanup `ws-close` uses `proof:null`. A second begin is rejected. This is the submission boundary: lost response means no browser dispatch and a conservative unknown helper outcome. Browser dispatch follows success without another awaited operation.
- `complete`: `{sessionId,epoch,id,result}`. HTTP success is `{ok:true,status,headers,body}`; socket command success is `{ok:true}`; failure is `{ok:false,code}` where code is `network_error|aborted|timeout|non_us|bad_response`. Identical completion replay is acknowledged without resolving work twice. Changed, expired or retired completion cannot resurrect work.
- `event`: `{sessionId,epoch,socketId,seq,event}` returns `{ok:true,seq}`. Events are `{type:'open'}`, `{type:'message',data}`, `{type:'error'}` or `{type:'close',code,wasClean}`. Sequence must be contiguous; exact duplicates are acknowledged without double emission. Each browser socket waits for the previous event ACK. Payloads never enter diagnostic logs.

Job kinds are `fetch`, `ws-open`, `ws-send`, `ws-close`. Fetch jobs carry the validated `url,method,headers,body?`; open carries `url,socketId`; send carries `socketId,data`; close carries `socketId,code,reason`. Close permits code1000 or3000–4999 and a UTF-8 reason at most123bytes. The Node WebSocket facade is a normal EventTarget with async events and no Node socket.

`extension/usa-policy.js` is the shared finite method/URL/header/body policy. Only documented OAuth paths, the helper's existing exact Helix operations, and `wss://eventsub.wss.twitch.tv/ws` are permitted. No arbitrary URL, header forwarding, redirect, browser cookie, global dispatcher or direct fallback exists.

## Bounds and terminal outcomes

HTTP/WS setup deadlines are ten seconds; each job carries its absolute expiry to the browser. Request bodies are at most64KiB, HTTP responses256KiB, and WS messages64KiB UTF-8. There are at most32 pending jobs and4 active sockets. Completed-job hashes retain at most512 entries; socket sequences retain64 hashes, and at most64 closed socket facades are retained. Retired worker sessions are capped512 with sixty-second expiry; exhaustion holds new sessions until entries expire. Tokens and bodies are not stored in these tombstones.

Stop, disconnect, lease loss, proof expiry, generation changes and worker replacement invalidate pending jobs and sockets. Work not begun is certified not submitted; begun work with missing outcome is unknown and is never replayed. Existing send history, host completions and budgets keep their no-retry behavior. Browser abort/close cleanup follows the changed epoch; no lost request is sent a second time.

## Installation and verification

Install only the fourth source, preserving its generated manifest key and all private files. Use the original package lock (no Undici dependency). Restart the held fourth helper, reload only the fourth extension, grant the fixed optional origins from its foreground button, and verify the exact fourth Chrome profile remains on Nord USA with kill switch. The browser then polls and attests; helper health stays available and held if permissions, worker, proof or lease are absent. A health result alone does not connect Twitch or arm chat. Root performs any live authorization only after native USA and paired relay verification. Original three source fingerprints and inactive settings must remain unchanged.

Official references: [Chrome cross-origin requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests), [extension WebSockets](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets), [Nord browser extension scope](https://support.nordvpn.com/hc/en-us/articles/20321910029585-Should-I-choose-NordVPN-app-or-NordVPN-extension).
