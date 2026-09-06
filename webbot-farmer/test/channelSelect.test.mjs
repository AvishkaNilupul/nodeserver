// Pure-function coverage for the farmer's ACL-aware channel selection
// (docs/WEBBOT-ACL-CHANNELS-CONTRACT.md, "Rules for the farmer" 1-6) and the
// channel pool's `avoid` option — no network, no Mongo, no docker.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  selectCandidates,
  normalizeGame,
  normalizeDoneCampaigns,
  doneCampaignsFromInventory,
  createChannelPool,
  readChannelsFile,
  channelsFilePath,
  CHANNELS_FILE_MAX_AGE_MS,
  DEFAULT_CHANNELS_FILE,
} from "../src/channelPool.js";

const MIN = 60 * 1000;
const NOW = Date.parse("2026-09-06T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

// A typical community fetch: two drops-tagged streams, one untagged, and the
// official channel (which happens to be in the top list too).
const ALL = [
  { login: "skyte", viewers: 5000, hasDropTag: true },
  { login: "vetelcito01", viewers: 3000, hasDropTag: true },
  { login: "rainbow6", viewers: 12000, hasDropTag: false },
  { login: "randomstreamer", viewers: 100, hasDropTag: false },
];

const file = (over = {}, campaigns) => ({
  v: 1,
  game: "Rainbow Six Siege",
  updatedAt: iso(NOW - 5 * MIN),
  campaigns:
    campaigns !== undefined
      ? campaigns
      : [
          {
            id: "c1",
            name: "R6S S2 2026 1",
            endAt: iso(NOW + 12 * 60 * MIN),
            acl: ["rainbow6", "rainbow6fr", "rainbow6br"],
            live: ["rainbow6fr"],
          },
        ],
  ...over,
});

const logins = (r) => r.candidates.map((c) => c.login);
const GAME = "Rainbow Six Siege";

test("normalizeGame: lowercase, non-alphanumerics → space, trim", () => {
  assert.equal(normalizeGame("Tom Clancy's Rainbow Six: Siege "), "tom clancy s rainbow six siege");
  assert.equal(normalizeGame("RAINBOW SIX SIEGE"), normalizeGame("rainbow-six_siege"));
  assert.equal(normalizeGame(null), "");
});

// ---- Rule 1: the file is ignored → today's behaviour ----------------------

test("rule 1: missing file → drops-tagged first, top-K", () => {
  const r = selectCandidates(ALL, null, NOW, { game: GAME });
  assert.equal(r.source, "community");
  assert.equal(r.fileState, "missing");
  assert.deepEqual(logins(r), ["skyte", "vetelcito01"]); // only the tagged ones
});

test("rule 1: unparsable file text → ignored", () => {
  const r = selectCandidates(ALL, "{not json", NOW, { game: GAME });
  assert.equal(r.source, "community");
  assert.equal(r.fileState, "unparsable");
  assert.deepEqual(logins(r), ["skyte", "vetelcito01"]);
});

test("rule 1: a file without a readable updatedAt → ignored", () => {
  const r = selectCandidates(ALL, file({ updatedAt: "yesterday-ish" }), NOW, { game: GAME });
  assert.equal(r.fileState, "unparsable");
  assert.equal(r.source, "community");
});

test("rule 1: updatedAt older than 45 min → ignored; exactly at the edge still used", () => {
  const stale = selectCandidates(ALL, file({ updatedAt: iso(NOW - 46 * MIN) }), NOW, { game: GAME });
  assert.equal(stale.fileState, "stale");
  assert.equal(stale.source, "community");

  const edge = selectCandidates(ALL, file({ updatedAt: iso(NOW - CHANNELS_FILE_MAX_AGE_MS) }), NOW, {
    game: GAME,
  });
  assert.equal(edge.fileState, "ok");
  assert.equal(edge.source, "acl-live");
});

test("rule 1: file for a different game → ignored; normalised spelling still matches", () => {
  const other = selectCandidates(ALL, file({ game: "Overwatch 2" }), NOW, { game: GAME });
  assert.equal(other.fileState, "game-mismatch");
  assert.equal(other.source, "community");

  const spelled = selectCandidates(ALL, file({ game: "rainbow-six_SIEGE" }), NOW, { game: "Rainbow Six: Siege" });
  assert.equal(spelled.fileState, "ok");
  assert.equal(spelled.source, "acl-live");
});

test("rule 1: file accepted as raw JSON text too", () => {
  const r = selectCandidates(ALL, JSON.stringify(file()), NOW, { game: GAME });
  assert.equal(r.source, "acl-live");
});

// ---- Rule 2: only running campaigns count --------------------------------

test("rule 2: an ended gated campaign is not considered (→ rule 6 / community)", () => {
  const ended = file({}, [
    { id: "old", name: "Old", endAt: iso(NOW - MIN), acl: ["rainbow6"], live: ["rainbow6"] },
  ]);
  const r = selectCandidates(ALL, ended, NOW, { game: GAME });
  assert.equal(r.source, "community");
  assert.deepEqual(logins(r), ["skyte", "vetelcito01"]);
});

test("rule 2: endAt null means still running; an unparsable endAt is kept (fail toward farming)", () => {
  const f = file({}, [
    { id: "a", name: "A", endAt: null, acl: ["rainbow6fr"], live: ["rainbow6fr"] },
    { id: "b", name: "B", endAt: "not-a-date", acl: ["rainbow6br"], live: ["rainbow6br"] },
  ]);
  const r = selectCandidates([], f, NOW, { game: GAME });
  assert.equal(r.source, "acl-live");
  assert.deepEqual(logins(r).sort(), ["rainbow6br", "rainbow6fr"]);
});

// ---- Rule 3: live ACL channels only ----------------------------------------

test("rule 3: live ACL logins become the ONLY candidates, never padded with community streams", () => {
  const r = selectCandidates(ALL, file(), NOW, { game: GAME });
  assert.equal(r.source, "acl-live");
  // rainbow6fr from `live`; rainbow6 because the farmer itself sees it live in `all`.
  assert.deepEqual(logins(r), ["rainbow6", "rainbow6fr"]);
  for (const c of r.candidates) {
    assert.equal(c.hasDropTag, true);
    assert.equal(c.fromAcl, true);
  }
  assert.ok(!logins(r).includes("skyte"), "community stream must not be padded in");
});

test("rule 3: a live ACL login not in `all` gets viewers 0; one in `all` keeps its viewers", () => {
  const r = selectCandidates(ALL, file(), NOW, { game: GAME });
  const byLogin = Object.fromEntries(r.candidates.map((c) => [c.login, c]));
  assert.equal(byLogin.rainbow6fr.viewers, 0);
  assert.equal(byLogin.rainbow6.viewers, 12000);
  assert.equal(logins(r)[0], "rainbow6"); // sorted by viewers desc
});

test("rule 3: liveAcl is the union over every gated campaign, deduped and case-folded", () => {
  const f = file({}, [
    { id: "a", name: "A", endAt: null, acl: ["rainbow6fr", "rainbow6"], live: ["Rainbow6FR"] },
    { id: "b", name: "B", endAt: null, acl: ["rainbow6br", "rainbow6fr"], live: ["rainbow6br", "rainbow6fr"] },
  ]);
  const r = selectCandidates([], f, NOW, { game: GAME });
  assert.deepEqual(logins(r).sort(), ["rainbow6br", "rainbow6fr"]);
});

test("rule 3: an ACL channel the farmer sees live in `all` counts even when the file's live is [] (server error)", () => {
  const f = file({ error: "Twitch 502" }, [
    { id: "c1", name: "R6S", endAt: null, acl: ["rainbow6", "rainbow6fr"], live: [] },
  ]);
  const r = selectCandidates(ALL, f, NOW, { game: GAME });
  assert.equal(r.source, "acl-live");
  assert.deepEqual(logins(r), ["rainbow6"]);
});

test("rule 3 wins over an un-gated sibling campaign when an ACL channel is live", () => {
  const f = file({}, [
    { id: "g", name: "Gated", endAt: null, acl: ["rainbow6fr"], live: ["rainbow6fr"] },
    { id: "u", name: "Open", endAt: null, acl: null, live: [] },
  ]);
  const r = selectCandidates(ALL, f, NOW, { game: GAME });
  assert.equal(r.source, "acl-live");
  assert.deepEqual(logins(r), ["rainbow6fr"]);
});

// ---- Rule 4: an un-gated campaign → today's behaviour -----------------------

test("rule 4: acl === null (un-gated) with no live ACL elsewhere → community list", () => {
  const f = file({}, [
    { id: "u", name: "Open", endAt: null, acl: null, live: [] },
    { id: "g", name: "Gated-dark", endAt: null, acl: ["rainbow6fr"], live: [] },
  ]);
  const r = selectCandidates(ALL, f, NOW, { game: GAME });
  assert.equal(r.source, "community");
  assert.deepEqual(logins(r), ["skyte", "vetelcito01"]);
});

test("rule 4: an empty acl array is treated as un-gated", () => {
  const f = file({}, [{ id: "u", name: "Open", endAt: null, acl: [], live: [] }]);
  const r = selectCandidates(ALL, f, NOW, { game: GAME });
  assert.equal(r.source, "community");
});

// ---- Rule 5: everything gated, nothing live → [] ----------------------------

test("rule 5: every active campaign gated and none live → [] with source none", () => {
  const f = file({}, [
    { id: "a", name: "A", endAt: null, acl: ["rainbow6fr"], live: [] },
    { id: "b", name: "B", endAt: null, acl: ["rainbow6br"], live: [] },
  ]);
  const r = selectCandidates(ALL, f, NOW, { game: GAME });
  assert.equal(r.source, "none");
  assert.deepEqual(r.candidates, []);
});

// ---- Rule 6: the file lists no campaigns → today's behaviour ---------------

test("rule 6: no campaigns at all → community list", () => {
  const r = selectCandidates(ALL, file({}, []), NOW, { game: GAME });
  assert.equal(r.source, "community");
  assert.equal(r.fileState, "ok");
  assert.deepEqual(logins(r), ["skyte", "vetelcito01"]);
  const noKey = selectCandidates(ALL, file({ campaigns: undefined }), NOW, { game: GAME });
  assert.equal(noKey.source, "community");
});

// ---- Today's behaviour details ---------------------------------------------

test("community: falls back to untagged streams only when none is drops-tagged, and respects topK", () => {
  const untagged = ALL.map((c) => ({ ...c, hasDropTag: false }));
  const r = selectCandidates(untagged, null, NOW, { game: GAME, topK: 3 });
  assert.deepEqual(logins(r), ["skyte", "vetelcito01", "rainbow6"]);
  const none = selectCandidates([], null, NOW, { game: GAME });
  assert.equal(none.source, "community");
  assert.deepEqual(none.candidates, []);
});

test("selectCandidates is pure: inputs are not mutated", () => {
  const all = ALL.map((c) => ({ ...c }));
  const f = file();
  const snapAll = JSON.stringify(all);
  const snapFile = JSON.stringify(f);
  selectCandidates(all, f, NOW, { game: GAME });
  assert.equal(JSON.stringify(all), snapAll);
  assert.equal(JSON.stringify(f), snapFile);
});

// ---- channelPool.next + the `avoid` option ---------------------------------

function poolWith({ all = ALL, fileText = null, clock } = {}) {
  let fetches = 0;
  const lines = [];
  const state = { all, fileText };
  const pool = createChannelPool({
    fetchChannels: async () => {
      fetches++;
      if (state.all instanceof Error) throw state.all;
      return state.all;
    },
    readChannels: async () => state.fileText,
    now: clock || (() => NOW),
    log: (m) => lines.push(m),
  });
  return { pool, state, lines, fetches: () => fetches };
}

test("pool.next: avoid skips those logins for this call only", async () => {
  const { pool } = poolWith();
  const a = await pool.next({}, GAME);
  assert.equal(a.login, "skyte");
  const b = await pool.next({}, GAME, { avoid: ["vetelcito01"] });
  assert.equal(b.login, "skyte"); // vetelcito01 skipped, wraps to the other candidate
  const c = await pool.next({}, GAME); // no avoid → plain round-robin resumes
  assert.equal(c.login, "vetelcito01");
});

test("pool.next: when every candidate is avoided the round-robin pick is returned anyway", async () => {
  const { pool } = poolWith();
  const ch = await pool.next({}, GAME, { avoid: ["SKYTE", "vetelcito01"] });
  assert.ok(["skyte", "vetelcito01"].includes(ch.login));
});

test("pool.next: rule 5 file → null, and the empty answer is cached for the refresh window (no re-fetch storm)", async () => {
  const gatedDark = JSON.stringify(
    file({}, [{ id: "a", name: "A", endAt: null, acl: ["rainbow6fr"], live: [] }]),
  );
  const { pool, fetches, lines } = poolWith({ fileText: gatedDark });
  assert.equal(await pool.next({}, GAME), null);
  assert.equal(await pool.next({}, GAME), null);
  assert.equal(await pool.next({}, GAME, { avoid: ["x"] }), null);
  assert.equal(fetches(), 1);
  assert.equal(pool.stats()[GAME].source, "none");
  assert.match(lines[0], /^channels\(Rainbow Six Siege\): none \(0\)$/);
});

test("pool.next: live ACL file → only ACL channels handed out; one log line per source change", async () => {
  const { pool, state, lines } = poolWith({ fileText: JSON.stringify(file()) });
  const first = await pool.next({}, GAME);
  assert.ok(first.fromAcl);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^channels\(Rainbow Six Siege\): acl-live \(2\): rainbow6, rainbow6fr$/);

  // Next window: file gone → back to community, logged once.
  let t = NOW;
  const { pool: p2, state: s2, lines: l2 } = poolWith({ fileText: JSON.stringify(file()), clock: () => t });
  await p2.next({}, GAME);
  s2.fileText = null;
  t += 4 * MIN;
  const ch = await p2.next({}, GAME); // stale → background refresh; served from cache first
  assert.ok(ch);
  await new Promise((r) => setTimeout(r, 5));
  const after = await p2.next({}, GAME);
  assert.ok(!after.fromAcl);
  assert.deepEqual(
    l2.map((l) => l.split(":")[1].trim().split(" ")[0]),
    ["acl-live", "community"],
  );
  assert.equal(state.fileText !== null, true);
});

test("pool.next: a Twitch fetch failure still serves a live ACL channel from the file", async () => {
  const { pool, state } = poolWith({ fileText: JSON.stringify(file()) });
  state.all = new Error("gql 503");
  const ch = await pool.next({}, GAME);
  assert.equal(ch.login, "rainbow6fr");
  assert.equal(ch.viewers, 0);
});

test("pool.next: a Twitch fetch failure with no file keeps returning null and retries", async () => {
  const { pool, state, fetches } = poolWith();
  state.all = new Error("gql 503");
  assert.equal(await pool.next({}, GAME), null);
  state.all = ALL;
  assert.ok(await pool.next({}, GAME));
  assert.equal(fetches(), 2);
});

// ---- readChannelsFile / path ------------------------------------------------

test("channelsFilePath honours WEBBOT_CHANNELS_FILE and readChannelsFile returns text or null", async () => {
  const prev = process.env.WEBBOT_CHANNELS_FILE;
  const dir = await mkdtemp(join(tmpdir(), "webbot-channels-"));
  try {
    delete process.env.WEBBOT_CHANNELS_FILE;
    assert.equal(channelsFilePath(), DEFAULT_CHANNELS_FILE);
    const p = join(dir, "channels.json");
    process.env.WEBBOT_CHANNELS_FILE = p;
    assert.equal(channelsFilePath(), p);
    assert.equal(await readChannelsFile(), null); // missing → null, never throws
    await writeFile(p, JSON.stringify(file()));
    const text = await readChannelsFile();
    assert.equal(typeof text, "string");
    assert.equal(selectCandidates(ALL, text, NOW, { game: GAME }).source, "acl-live");
  } finally {
    if (prev === undefined) delete process.env.WEBBOT_CHANNELS_FILE;
    else process.env.WEBBOT_CHANNELS_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- Per-account campaign exclusion (doneCampaigns) -------------------------
// Two gated campaigns: A has a live official channel, B is dark.
const TWO_GATED = [
  { id: "a", name: "R6S S2 2026 1", endAt: null, acl: ["rainbow6fr"], live: ["rainbow6fr"] },
  { id: "b", name: "R6S Esports Pack", endAt: null, acl: ["rainbow6br"], live: [] },
];

test("normalizeDoneCampaigns: normalised, deduped, sorted; empties dropped; non-arrays → []", () => {
  assert.deepEqual(normalizeDoneCampaigns(["R6S S2 2026-1", "r6s s2 2026 1", "Zed", "", null]), ["r6s s2 2026 1", "zed"]);
  assert.deepEqual(normalizeDoneCampaigns(undefined), []);
  assert.deepEqual(normalizeDoneCampaigns("nope"), []);
});

test("doneCampaigns: done campaigns are dropped BEFORE rules 2-6 (remaining gated-dark → rule 5 none)", () => {
  const f = file({}, TWO_GATED);
  const none = selectCandidates([], f, NOW, { game: GAME });
  assert.equal(none.source, "acl-live");
  assert.deepEqual(logins(none), ["rainbow6fr"]);

  const r = selectCandidates([], f, NOW, { game: GAME, doneCampaigns: ["R6S S2 2026 1"] });
  assert.equal(r.source, "none"); // A excluded; B is gated and dark
  assert.deepEqual(r.candidates, []);
});

test("doneCampaigns: every listed campaign done → [] with source done", () => {
  const r = selectCandidates(ALL, file({}, TWO_GATED), NOW, {
    game: GAME,
    doneCampaigns: ["R6S S2 2026 1", "R6S Esports Pack"],
  });
  assert.equal(r.source, "done");
  assert.equal(r.fileState, "ok");
  assert.deepEqual(r.candidates, []);
});

test("doneCampaigns: name compare is normalised (case / punctuation) and unknown names are ignored", () => {
  const f = file({}, TWO_GATED);
  const spelled = selectCandidates([], f, NOW, { game: GAME, doneCampaigns: ["r6s-s2_2026:1", "R6S ESPORTS PACK"] });
  assert.equal(spelled.source, "done");
  const unknown = selectCandidates([], f, NOW, { game: GAME, doneCampaigns: ["Some Other Campaign"] });
  assert.equal(unknown.source, "acl-live");
  assert.deepEqual(logins(unknown), ["rainbow6fr"]);
});

test("doneCampaigns: an un-gated sibling that is NOT done keeps today's behaviour (rule 4)", () => {
  const f = file({}, [TWO_GATED[0], { id: "u", name: "Open", endAt: null, acl: null, live: [] }]);
  const r = selectCandidates(ALL, f, NOW, { game: GAME, doneCampaigns: ["R6S S2 2026 1"] });
  assert.equal(r.source, "community");
  assert.deepEqual(logins(r), ["skyte", "vetelcito01"]);
});

test("doneCampaigns: done is only reported when the file listed campaigns (rule 6 / rule 1 states unaffected)", () => {
  const empty = selectCandidates(ALL, file({}, []), NOW, { game: GAME, doneCampaigns: ["R6S S2 2026 1"] });
  assert.equal(empty.source, "community");
  assert.equal(empty.fileState, "ok");
  const missing = selectCandidates(ALL, null, NOW, { game: GAME, doneCampaigns: ["R6S S2 2026 1"] });
  assert.equal(missing.source, "community");
  assert.equal(missing.fileState, "missing");
  const other = selectCandidates(ALL, file({ game: "Overwatch 2" }, TWO_GATED), NOW, {
    game: GAME,
    doneCampaigns: ["R6S S2 2026 1", "R6S Esports Pack"],
  });
  assert.equal(other.fileState, "game-mismatch");
  assert.equal(other.source, "community");
});

test("doneCampaigns: a done campaign next to an ended one → the ended one still goes through rule 2 (fail toward farming)", () => {
  const f = file({}, [
    TWO_GATED[0],
    { id: "old", name: "Old", endAt: iso(NOW - MIN), acl: ["rainbow6"], live: ["rainbow6"] },
  ]);
  const r = selectCandidates(ALL, f, NOW, { game: GAME, doneCampaigns: ["R6S S2 2026 1"] });
  assert.equal(r.source, "community"); // not "done": the file still listed a (now ended) campaign
});

test("doneCampaignsFromInventory: claimed or fully-watched drops → done; partial / zero-required / no drops / other game → not", () => {
  const camp = (name, game, drops) => ({ name, game: { displayName: game }, timeBasedDrops: drops });
  const drop = (cur, req, claimed = false) => ({
    requiredMinutesWatched: req,
    self: { currentMinutesWatched: cur, isClaimed: claimed },
  });
  const inv = {
    data: {
      currentUser: {
        inventory: {
          dropCampaignsInProgress: [
            camp("All claimed", "Rainbow Six Siege", [drop(60, 60, true), drop(0, 120, true)]),
            camp("Fully watched", "Rainbow Six: Siege", [drop(60, 60), drop(130, 120, false)]),
            camp("Half way", "Rainbow Six Siege", [drop(60, 60, true), drop(30, 60)]),
            camp("Zero required", "Rainbow Six Siege", [drop(5, 0)]),
            camp("No drops", "Rainbow Six Siege", []),
            camp("Other game", "Overwatch 2", [drop(60, 60, true)]),
            { name: "Missing self", game: { displayName: "Rainbow Six Siege" }, timeBasedDrops: [{ requiredMinutesWatched: 60 }] },
            null,
          ],
        },
      },
    },
  };
  assert.deepEqual(doneCampaignsFromInventory(inv, GAME), ["All claimed", "Fully watched"]);
  assert.deepEqual(doneCampaignsFromInventory(inv, "Overwatch 2"), ["Other game"]);
  assert.deepEqual(doneCampaignsFromInventory(null, GAME), []);
  assert.deepEqual(doneCampaignsFromInventory({ data: {} }, GAME), []);
});

test("pool.next: doneCampaigns selects a separate game+done pool, sharing ONE Twitch fetch per game", async () => {
  const { pool, fetches, lines } = poolWith({ fileText: JSON.stringify(file({}, TWO_GATED)) });
  assert.equal(pool.source(GAME), null); // nothing cached yet

  const plain = await pool.next({}, GAME);
  assert.equal(plain.login, "rainbow6fr");
  assert.equal(pool.source(GAME), "acl-live");

  const doneA = await pool.next({}, GAME, { doneCampaigns: ["R6S S2 2026 1"] });
  assert.equal(doneA, null);
  assert.equal(pool.source(GAME, { doneCampaigns: ["R6S S2 2026 1"] }), "none");

  const doneAll = await pool.next({}, GAME, { doneCampaigns: ["R6S Esports Pack", "R6S S2 2026 1"] });
  assert.equal(doneAll, null);
  assert.equal(pool.source(GAME, { doneCampaigns: ["R6S S2 2026 1", "R6S Esports Pack"] }), "done");

  // The plain pool is untouched by the per-account exclusions.
  assert.equal((await pool.next({}, GAME)).login, "rainbow6fr");
  assert.equal(fetches(), 1, "all three pools must share the one per-game fetch");

  const stats = pool.stats();
  assert.deepEqual(Object.keys(stats).sort(), [
    GAME,
    `${GAME}|r6s esports pack,r6s s2 2026 1`,
    `${GAME}|r6s s2 2026 1`,
  ].sort());
  assert.equal(stats[GAME].source, "acl-live");
  assert.equal(stats[`${GAME}|r6s esports pack,r6s s2 2026 1`].source, "done");
  assert.deepEqual(stats[`${GAME}|r6s s2 2026 1`].doneCampaigns, ["r6s s2 2026 1"]);

  // One source line per pool, the exclusion pools tagged with what they exclude.
  assert.deepEqual(lines, [
    `channels(${GAME}): acl-live (1): rainbow6fr`,
    `channels(${GAME}): none (0) [excluding done: r6s s2 2026 1]`,
    `channels(${GAME}): done (0) [excluding done: r6s esports pack, r6s s2 2026 1]`,
  ]);
});

test("pool.next: the cache key is order- and spelling-insensitive over doneCampaigns", async () => {
  const { pool, fetches } = poolWith({ fileText: JSON.stringify(file({}, TWO_GATED)) });
  await pool.next({}, GAME, { doneCampaigns: ["R6S S2 2026 1", "R6S Esports Pack"] });
  await pool.next({}, GAME, { doneCampaigns: ["r6s-esports-pack", "R6S S2 2026 1", "R6S S2 2026 1"] });
  assert.equal(Object.keys(pool.stats()).length, 1);
  assert.equal(fetches(), 1);
});

test("pool.next: across refresh windows the per-game fetch is re-done once and shared by every pool key", async () => {
  let t = NOW;
  const { pool, fetches } = poolWith({ fileText: JSON.stringify(file({}, TWO_GATED)), clock: () => t });
  await pool.next({}, GAME);
  await pool.next({}, GAME, { doneCampaigns: ["R6S S2 2026 1"] });
  assert.equal(fetches(), 1);

  t += 4 * MIN; // both pools stale
  await pool.next({}, GAME); // non-empty list → served from cache, refresh in background
  await pool.next({}, GAME, { doneCampaigns: ["R6S S2 2026 1"] }); // empty list → awaits the shared refresh
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(fetches(), 2);
  assert.equal(pool.source(GAME), "acl-live");
  assert.equal(pool.source(GAME, { doneCampaigns: ["R6S S2 2026 1"] }), "none");
});

test("pool.next: a Twitch fetch failure is not cached for other pool keys either (each call retries)", async () => {
  const { pool, state, fetches } = poolWith();
  state.all = new Error("gql 503");
  assert.equal(await pool.next({}, GAME), null);
  assert.equal(await pool.next({}, GAME, { doneCampaigns: ["X"] }), null);
  assert.equal(fetches(), 2);
  state.all = ALL;
  assert.ok(await pool.next({}, GAME, { doneCampaigns: ["X"] }));
  assert.equal(fetches(), 3);
  assert.ok(await pool.next({}, GAME)); // shares the now-fresh fetch
  assert.equal(fetches(), 3);
});
