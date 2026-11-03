# Steam worker

Runs `worker.cjs` under Node 22 in a Docker container on the farm host. Build with
`docker build -t steam-booster .`. Supply a mode-600 env file containing
`STEAM_BOOST_WORKER_TOKEN`, `BOOST_API_URL`, `RES_HOST`, `RES_PORT`, `RES_USER`, and
`RES_PASS`. Never commit that file. The API URL must be loopback HTTP through the
private SSH reverse tunnel; it defaults to `http://127.0.0.1:18130/boost-worker/v1/`.

The production app starts its bearer-authenticated worker API on 127.0.0.1:3011
only. The reverse tunnel exposes that API only on the worker host's loopback
port 18130. The worker uses host networking to reach it. Run one worker instance;
stop and remove the old container before replacing it. Keep restart
`unless-stopped`, a 512 MB memory ceiling, a read-only root filesystem and a
writable temporary directory. No persistent Steam login files are used.

Steam passwords/tokens come from the server for the exact assignment generation;
mail codes come from its existing Outlook reader. The worker stops removed or
changed assignments, confirms logout before inventory is released, and logs off
all sessions after three minutes without assignment reads. The server holds
stopping accounts until it receives confirmation; a disconnected worker cannot
make an account sellable by itself.

Validation: run `node --test tests/steamBoostWorker.test.js` from the repo root
after installing this folder's dependencies. Full pipeline tests are in
`tests/steamSales.test.js` and `tests/steamG2g.test.js`.
