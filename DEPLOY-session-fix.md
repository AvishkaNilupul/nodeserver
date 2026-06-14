# Fix: admin messages stop sending "after a while"

## Cause
Sessions were kept in memory (default express-session store). Every time the
node process restarted (your PM2 process has been restarting a lot), ALL logged-in
sessions were wiped. The admin page stays open and its websocket silently
reconnects, but the server no longer recognises the session, so the socket is
treated as "not an admin" and `admin-message` is silently ignored -> your text
never sends.

## Fix
- Sessions are now stored in MongoDB (connect-mongo), so logins survive restarts.
- The admin page re-checks its auth on every (re)connect and, if the session was
  truly lost, shows "session expired, please log in again" and redirects to the
  login page instead of silently failing.

## Files in this zip
- server.js              (adds connect-mongo session store)
- socket/chatSocket.js   (adds admin-check / admin-auth so the page can detect lost auth)
- public/admin.html      (client re-auth on reconnect — also includes the earlier mobile changes)
- package.json / package-lock.json (adds the connect-mongo dependency)

## Deploy
    cd /var/www/redeemer/nodeserver
    # replace the 5 files above (keep paths: socket/chatSocket.js, public/admin.html)
    npm install            # installs connect-mongo
    pm2 restart redeemer

That's it. No DB migration needed — a "sessions" collection is created
automatically in your codesDB database. Everyone will need to log in once more
after this deploy (old in-memory sessions are gone), but from then on logins
persist across restarts.

## Strongly recommended (separate issue)
Your logs also show the process crash-looping on `Cannot find module
'../models/Item'`. This session fix makes restarts non-disruptive, but you should
still fix that crash so the server stops restarting. If it still happens, send me
`pm2 logs redeemer --lines 50 --nostream`.
