// In-memory SOOP for tests and the dev harness (contract §12). No network.
//
// `world.clientFor` hands back the §7 client shape, so it can be given straight
// to farm.setClientFactory. The world reproduces the rules that matter to the
// farm: watch time is credited only through a joined bridge on an on-air channel
// of a LIVE campaign, from a country SOOP pays in, when the claimed country is
// the one the connection is seen from (§4). A delisted campaign leaves the
// event list but its missions keep counting (whether the real site ever does
// that mid-broadcast is not known; the farm's old list reader made it look so).
// A stream says whether it carries drops (`IS_DROPS` in its player info), and a
// listed channel can be on air with a broadcast of its own that carries none
// (world.setDrops). world.setDropsFlag makes a stream SAY something other than
// the truth, and world.failList makes one of the two campaign lists unreadable.
const crypto = require("crypto");
const { SoopError } = require("../../utils/soop/errors");
const { creditStatus } = require("../../utils/soop/geo");

const DIVISIONS = ["available", "acquired", "expired"];
const METHODS =
  "privateInfo missions campaigns campaignsAll liveInfo categoryChannels inventoryCounts inventory useInfo openBridge".split(" ");
// The calls that go to drops.sooplive.com. On 2026-10-11 the real site refused
// all of them ("Please log in to continue.") for logins the main site still
// called signed in — the event list included, which is not public.
const DROPS_SITE = new Set(["missions", "campaigns", "campaignsAll", "inventoryCounts", "inventory", "useInfo"]);
const DAY = 24 * 3600 * 1000;
const clone = (v) => JSON.parse(JSON.stringify(v));
const cc = (v) => (v ? String(v).trim().toUpperCase() : null);
// SOOP timestamps are Korea wall-clock strings with no zone.
const kst = (ms) =>
  new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");

// `rewards: true` makes the world hand a reward out — an unclaimed inventory
// row — each time an account's minutes cross one of a campaign's steps, as the
// real site does a minute or so after the step.
function createFakeSoop({ now = Date.now, rewards = false } = {}) {
  const accounts = new Map(); // id -> account
  const tickets = new Map(); // AuthTicket value -> id
  const campaigns = new Map(); // dropsIdx -> raw row (insertion order = list order)
  const delisted = new Set();
  // world.useCateList(): list rows as SOOP has sent them since 2026-10-15 — the
  // category in `cateList: [{ cateNo, cateName }]`, no top-level `cateNo`.
  let cateListShape = false;
  const unreadable = new Map(); // "progress" / "scheduled" -> how many more reads of it get no answer
  const channels = new Map(); // id -> { id, nick, onAir, cateNo, bno }
  const open = []; // bridges that are not closed
  const egress = { country: null, down: false };
  const counts = Object.fromEntries(METHODS.map((m) => [m, 0]));
  let seq = 9000;
  let bno = 290000000;

  // The country SOOP sees for this account's connection: the egress when one is
  // set, else the account's own.
  const seenCountry = (acct) => egress.country || (acct && acct.country) || null;

  function channel(id, patch = {}) {
    const key = String(id);
    let ch = channels.get(key);
    if (!ch) {
      ch = { id: key, nick: key, onAir: false, cateNo: null, bno: null, dropsOff: false, says: null };
      channels.set(key, ch);
    }
    if (patch.nick) ch.nick = String(patch.nick);
    if (patch.cateNo) ch.cateNo = String(patch.cateNo);
    if (typeof patch.onAir === "boolean" && patch.onAir !== ch.onAir) {
      ch.onAir = patch.onAir;
      ch.bno = patch.onAir ? String(++bno) : null;
    }
    return ch;
  }

  function closeBridge(b, events = ["closed"], error = null) {
    if (b.state.closed) return;
    b.state.closed = true;
    if (error) b.state.error = error;
    const i = open.indexOf(b);
    if (i >= 0) open.splice(i, 1);
    for (const ev of events) b.emit(ev);
  }

  const covers = (row, ch) =>
    row.broadIdList.length
      ? row.broadIdList.some((x) => x.userId === ch.id)
      : Boolean(row.cateNo) && ch.cateNo === row.cateNo;

  // What the stream's player info says, and what `advance` credits by.
  const carries = (ch) =>
    !ch.dropsOff && [...campaigns.values()].some((row) => row.live && covers(row, ch));

  const world = {
    addAccount({ id, nick, country = "LK", loggedIn = true } = {}) {
      const key = String(id);
      const ticket = `fake-ticket-${key}-${crypto.randomBytes(6).toString("hex")}`;
      accounts.set(key, {
        id: key,
        nick: nick || key,
        country: cc(country),
        loggedIn: loggedIn !== false,
        minutes: new Map(), // dropsIdx -> minutes watched
        inventory: { available: [], acquired: [], expired: [] },
      });
      tickets.set(ticket, key);
      return [{ name: "AuthTicket", value: ticket }];
    },

    // Fields as in _soop-probe/events.json. Channels may be given as plain ids.
    // `cateChannels: [ids]` (not a SOOP field, stripped from the row) names the
    // channels streaming in `cateNo`, which is what a category-wide campaign
    // farms. A new channel starts on air when its row says so, else when the
    // campaign is created live; a channel the world already knows keeps its state.
    addCampaign(partial = {}) {
      const { cateChannels, ...p } = partial;
      const dropsIdx = String(p.dropsIdx || ++seq);
      const t = now();
      const filter = p.filter || "progress";
      const live = p.live === true;
      const cateNo = p.cateNo ? String(p.cateNo) : null;
      const given = p.broadIdList || (cateNo ? [] : [`ch${dropsIdx}`]);
      const broadIdList = given.map((b) => {
        const o = typeof b === "string" ? { userId: b } : b;
        const userId = String(o.userId);
        const known = channels.get(userId);
        const on = typeof o.onAir === "boolean" ? o.onAir : known ? known.onAir : live;
        channel(userId, { nick: o.userNick, onAir: on });
        return { userNick: userId, broadNo: null, stationNo: null, broadCateNo: null, ...o, userId, onAir: on };
      });
      if (cateNo) {
        const ids = cateChannels || (broadIdList.length ? [] : [`cate${cateNo}a`]);
        for (const id of ids) {
          const known = channels.has(String(id));
          channel(id, known ? { cateNo } : { cateNo, onAir: live });
        }
      }
      const itemList = (p.itemList || [30, 60]).map((i, n) => ({
        ...{ itemType: "1", itemName: `Reward ${n + 1}`, itemImage: null },
        ...{ giveCon: null, giveEndDate: null, ongoingTerm: "0" },
        ...(typeof i === "object" ? i : {}),
        giveTerm: String(typeof i === "object" ? (i.giveTerm ?? 0) : i),
      }));
      const row = {
        ...{ image: null, ingameGiveYn: "N", dupFlag: "N", giveCon: "term", dropsType: "C", url: null },
        ...{ gameNo: "12", typeNm: null, guideStr: null, loginPath: null, cateName: null },
        ...{ acctConn: false, acctLinkPath: null, acctLinkImage: null },
        title: `Fake drops event ${dropsIdx}`,
        startDate: kst(t + (filter === "scheduled" ? DAY : -DAY)),
        endDate: kst(t + (filter === "completed" ? -3600 * 1000 : 7 * DAY)),
        ...p,
        dropsIdx,
        filter,
        live,
        broadIdList,
        cateNo,
        itemList,
      };
      campaigns.set(dropsIdx, row);
      for (const b of broadIdList) world.setOnAir(b.userId, b.onAir); // one flag per channel, on every row
      return clone(row);
    },

    setLive(dropsIdx, on) {
      const row = campaigns.get(String(dropsIdx));
      if (row) row.live = Boolean(on);
      return Boolean(row);
    },

    // `cateNo` (optional) files the channel under a category for categoryChannels().
    setOnAir(channelId, on, { cateNo } = {}) {
      const ch = channel(channelId, { onAir: Boolean(on), cateNo });
      for (const row of campaigns.values()) {
        for (const b of row.broadIdList) if (b.userId === ch.id) b.onAir = ch.onAir;
      }
      // The broadcast ended: SOOP closes every viewer's bridge.
      if (!ch.onAir) {
        for (const b of open.filter((x) => x.channel === ch.id)) {
          closeBridge(b, ["server-close:CLOSEBROAD", "closed"]);
        }
      }
    },

    // `false`: whenever the channel is on air it is with a stream of its own —
    // its player info says IS_DROPS 0 and nobody watching it is credited.
    setDrops(channelId, on = true) {
      channel(channelId).dropsOff = on === false;
    },

    // What the stream's player info SAYS (1 / 0), whatever is really counted;
    // null goes back to the truth. Never observed on the real site: it is here
    // so the tests can show the farm does not depend on the flag being right.
    setDropsFlag(channelId, value = null) {
      channel(channelId).says = value;
    },

    // One of SOOP's two campaign lists ("progress" / "scheduled") stops
    // answering — for good, or for the next `on` reads when a number is given —
    // or with `false` answers again: a lost request, not a delisting.
    failList(filter, on = true) {
      if (on === false || on === 0) unreadable.delete(filter);
      else unreadable.set(filter, on === true ? Infinity : Number(on));
    },

    useCateList(on = true) {
      cateListShape = on !== false;
    },

    delist(dropsIdx) {
      const key = String(dropsIdx);
      if (campaigns.has(key)) delisted.add(key);
      return campaigns.has(key);
    },

    logout(id) {
      const acct = accounts.get(String(id));
      if (!acct) return false;
      acct.loggedIn = false;
      for (const b of open.filter((x) => x.id === acct.id)) closeBridge(b);
      return true;
    },

    // The drops site stops (or, with `false`, starts again) accepting a login
    // that the main site still calls signed in. Open bridges stay open.
    rejectDrops(id, on = true) {
      const acct = accounts.get(String(id));
      if (!acct) return false;
      acct.dropsRejected = on !== false;
      return true;
    },

    // SOOP answers every claim / check-info call of this login with a refusal
    // that is not about the login, until switched back. `code`: "API" SOOP said
    // no · "HTTP" what came back could not be read (an error page).
    refuseClaims(id, on = true, code = "API") {
      const acct = accounts.get(String(id));
      if (!acct) return false;
      acct.claimsRefused = on !== false ? code : null;
      return true;
    },

    // Only the keys given change. Going down drops every open bridge, as a dead
    // tunnel would; a country change leaves bridges open with a stale claim.
    setEgress({ country, down } = {}) {
      if (country !== undefined) egress.country = cc(country);
      if (down !== undefined) egress.down = Boolean(down);
      if (egress.down) for (const b of [...open]) closeBridge(b, ["closed"], "egress");
    },

    addInventory(id, rawItem = {}, division = "available") {
      const acct = accounts.get(String(id));
      if (!acct) throw new Error(`fake SOOP: no account ${id}`);
      if (!DIVISIONS.includes(division)) throw new Error(`fake SOOP: bad division ${division}`);
      const t = now();
      const row = {
        itemCodeIdx: String(++seq), // the id SOOP's inventory really uses
        ...{ itemType: "1", itemName: "Fake reward", itemImage: null, gameNo: "12", typeNm: null },
        ...{ ingameGiveYn: "N", acctConn: false, acctLinkPath: null, loginPath: null, useFlag: "N" },
        sendDate: kst(t - DAY),
        expDate: kst(t + (division === "expired" ? -DAY : 14 * DAY)),
        receiveDate: division === "acquired" ? kst(t - 3600 * 1000) : null,
        ...rawItem,
      };
      acct.inventory[division].push(row);
      return clone(row);
    },

    // Takes a reward out of an account's inventory, whichever list it is in
    // (SOOP stops listing it), or changes what its claim will answer.
    removeInventory(id, itemCodeIdx) {
      const acct = accounts.get(String(id));
      let n = 0;
      for (const d of DIVISIONS) {
        const before = acct ? acct.inventory[d].length : 0;
        if (acct) acct.inventory[d] = acct.inventory[d].filter((r) => String(r.itemCodeIdx) !== String(itemCodeIdx));
        n += before - (acct ? acct.inventory[d].length : 0);
      }
      return n;
    },
    setClaimCode(id, itemCodeIdx, code) {
      const acct = accounts.get(String(id));
      const row = acct && DIVISIONS.flatMap((d) => acct.inventory[d]).find((r) => String(r.itemCodeIdx) === String(itemCodeIdx));
      if (row) Object.assign(row, { claimCode: code, noCode: false });
      return Boolean(row);
    },

    advance(minutes = 1) {
      const credited = [];
      if (egress.down) return credited;
      const seen = new Set();
      for (const b of open) {
        const acct = accounts.get(b.id);
        const ch = channels.get(b.channel);
        if (!b.state.joined || !acct || !acct.loggedIn || !ch || !ch.onAir || ch.dropsOff) continue;
        const country = seenCountry(acct);
        if (b.claimedCountry !== country || creditStatus(country) !== "yes") continue;
        for (const row of campaigns.values()) {
          const key = `${acct.id}|${row.dropsIdx}`;
          if (!row.live || !covers(row, ch) || seen.has(key)) continue;
          seen.add(key);
          const had = acct.minutes.get(row.dropsIdx) || 0;
          const total = had + Number(minutes);
          acct.minutes.set(row.dropsIdx, total);
          credited.push({ id: acct.id, dropsIdx: row.dropsIdx, minutes: total });
          if (!rewards) continue;
          for (const item of row.itemList) {
            const step = Number(item.giveTerm) || 0;
            if (step > had && step <= total) {
              world.addInventory(acct.id, {
                ...{ itemName: item.itemName, itemType: item.itemType, gameNo: row.gameNo },
                ...{ ingameGiveYn: row.ingameGiveYn, claimCode: `CODE-${acct.id}-${row.dropsIdx}-${step}` },
              });
            }
          }
        }
      }
      return credited;
    },

    bridges: () =>
      open.map((b) => ({
        ...{ id: b.id, clientId: b.clientId, channel: b.channel },
        ...{ joined: b.state.joined, claimedCountry: b.claimedCountry },
      })),

    // campaignsAll counts once as `campaignsAll`, not as two `campaigns` calls.
    calls: () => ({ ...counts }),

    clientFor(cookies, { id = null, geo = null } = {}) {
      const ticket = (cookies || []).find((c) => c && c.name === "AuthTicket");
      if (!ticket) throw new Error("no AuthTicket in cookie set (logged-out export?)");
      const acct = accounts.get(tickets.get(ticket.value)) || null; // unknown ticket = logged out

      const enter = (method, needsLogin) => {
        counts[method] += 1;
        if (egress.down) {
          throw new SoopError("fake egress is down (proxy unreachable)", { code: "EGRESS" });
        }
        if (needsLogin && !(acct && acct.loggedIn)) {
          throw new SoopError("Please log in. (로그인이 필요합니다)", { code: "AUTH" });
        }
        if (acct && acct.dropsRejected && DROPS_SITE.has(method)) {
          throw new SoopError("Please log in to continue.", { code: "AUTH" });
        }
      };
      const shaped = (row) => {
        if (!cateListShape) return row;
        const { cateNo, cateName, ...rest } = row;
        const cateList = cateNo ? [{ cateNo, cateName: cateName || "", cateImg: null, cateImgMo: null }] : [];
        return { ...rest, cateGroupNo: null, cateGroupName: null, cateList };
      };
      const listed = (filter) =>
        [...campaigns.values()]
          .filter((r) => r.filter === filter && !delisted.has(r.dropsIdx))
          .map((r) => shaped({ ...clone(r), filter }));
      // Does this read of the list get no answer? (Counts a limited outage down.)
      const lost = (filter) => {
        const left = unreadable.get(filter);
        if (!left) return false;
        if (left !== Infinity) unreadable.set(filter, left - 1);
        return true;
      };

      async function privateInfo() {
        enter("privateInfo", false);
        const on = Boolean(acct && acct.loggedIn);
        return { loggedIn: on, loginId: on ? acct.id : "", nick: on ? acct.nick : "", country: seenCountry(acct) };
      }

      function openBridge(bj, ch, { onEvent } = {}) {
        counts.openBridge += 1;
        const state = { joined: false, closed: false, error: null, stop: null };
        const emit = (ev) => {
          try {
            if (onEvent) onEvent(ev);
          } catch {
            // a listener must never break the world
          }
        };
        const b = { id: acct ? acct.id : null, clientId: id, channel: String(bj), claimedCountry: null, state, emit };
        state.stop = () => {
          if (state.closed) return;
          state.closed = true;
          const i = open.indexOf(b);
          if (i >= 0) open.splice(i, 1);
          setImmediate(() => b.emit("closed"));
        };
        if (egress.down) {
          state.error = "egress";
          state.closed = true;
          return state;
        }
        open.push(b);
        setImmediate(async () => {
          if (state.closed) return;
          b.emit("open");
          let claim = null;
          try {
            claim = geo
              ? (await geo.get(async () => (await privateInfo()).country)).cc
              : seenCountry(acct);
          } catch {
            claim = null;
          }
          if (state.closed) return;
          if (!claim) return closeBridge(b, ["error:geo", "closed"], "geo");
          b.claimedCountry = cc(claim);
          const live = channels.get(b.channel);
          if (!acct || !acct.loggedIn || !live || !live.onAir) return closeBridge(b);
          state.joined = true;
          b.emit("joined");
        });
        return state;
      }

      return {
        id,
        privateInfo,
        async missions() {
          enter("missions", true);
          return [...acct.minutes].map(([dropsIdx, minutes]) => ({
            dropsIdx,
            minutes,
            items: campaigns.get(dropsIdx).itemList.map((i) => ({
              name: i.itemName,
              minutes: Number(i.giveTerm) || 0,
              viewTime: minutes,
            })),
          }));
        },
        async campaigns(filter = "progress") {
          enter("campaigns", false);
          if (lost(filter)) throw new SoopError(`fake SOOP: the ${filter} list did not answer`, { code: "TIMEOUT" });
          return listed(filter);
        },
        // Like the real client: a list that did not answer is named in `unread`,
        // and with nothing at all to hand over the failure is thrown.
        async campaignsAll() {
          enter("campaignsAll", false);
          const unread = ["progress", "scheduled"].filter(lost);
          const rows = ["progress", "scheduled"].filter((f) => !unread.includes(f)).flatMap(listed);
          if (unread.length && !rows.length) throw new SoopError(`fake SOOP: the ${unread[0]} list did not answer`, { code: "TIMEOUT" });
          if (unread.length) {
            rows.unread = unread;
            rows.unreadWhy = unread.map((f) => `${f}: fake SOOP did not answer`).join("; ");
          }
          return rows;
        },
        async liveInfo(bj) {
          enter("liveInfo", false);
          const ch = channels.get(String(bj));
          if (!ch || !ch.onAir) return { RESULT: 0 };
          const gates = { GWIP: "10.0.0.1", GWPT: "8001", CTIP: "10.0.0.2", CTPT: "8002" };
          return {
            ...{ RESULT: 1, BJID: ch.id, BJNICK: ch.nick, BNO: ch.bno },
            ...{ CATE: ch.cateNo || "00130000", FTK: `fake-ftk-${ch.id}`, ...gates },
            IS_DROPS: ch.says ?? (carries(ch) ? 1 : 0),
          };
        },
        async categoryChannels(cateNo, limit = 5) {
          enter("categoryChannels", false);
          return [...channels.values()]
            .filter((c) => c.onAir && c.cateNo === String(cateNo))
            .slice(0, limit)
            .map((c) => c.id);
        },
        async inventoryCounts() {
          enter("inventoryCounts", true);
          return Object.fromEntries(DIVISIONS.map((d) => [d, acct.inventory[d].length]));
        },
        async inventory(division) {
          enter("inventory", true);
          const from = DIVISIONS.includes(division) ? [division] : DIVISIONS;
          return from.flatMap((d) => clone(acct.inventory[d])).map(({ claimCode, ...row }) => row);
        },
        // Like SOOP: the first call on an unclaimed reward claims it, later
        // calls only read. The code lives here, never in the list rows.
        async useInfo(itemCodeIdx) {
          enter("useInfo", true);
          if (acct.claimsRefused === "HTTP") throw new SoopError("https://drops.sooplive.com/api/x -> HTTP 502: <html>Bad Gateway", { code: "HTTP" });
          if (acct.claimsRefused) throw new SoopError("Rewards cannot be handed out right now.", { code: "API" });
          const key = String(itemCodeIdx);
          const match = (r) => String(r.itemCodeIdx) === key;
          // One reward SOOP answers "log in" for while the login is fine
          // (`authOnClaim: true` on the row).
          const odd = DIVISIONS.flatMap((d) => acct.inventory[d]).find(match);
          if (odd && odd.authOnClaim) throw new SoopError("Please log in to continue.", { code: "AUTH" });
          // ...or refuses (`refuseOnClaim`), or never answers readably (`httpOnClaim`).
          if (odd && odd.refuseOnClaim) throw new SoopError("This reward cannot be handed out.", { code: "API" });
          if (odd && odd.httpOnClaim) throw new SoopError("https://drops.sooplive.com/api/x -> HTTP 502: <html>Bad Gateway", { code: "HTTP" });
          let row = acct.inventory.acquired.find(match);
          if (!row) {
            const i = acct.inventory.available.findIndex(match);
            if (i < 0) throw new SoopError("No such reward.", { code: "API" });
            [row] = acct.inventory.available.splice(i, 1);
            // A reissued reward (`renewFlag: "Y"` on the row): the old item is
            // withdrawn unclaimed and a new one takes its place in the inventory.
            if (row.renewFlag === "Y") {
              const { renewFlag, itemCodeIdx: _old, ...rest } = row;
              acct.inventory.available.push({ ...rest, itemCodeIdx: String(++seq) });
              return { itemCode: "", itemType: row.itemType, itemName: row.itemName, renewFlag: "Y", itemDescription: "" };
            }
            row.useFlag = "Y";
            row.receiveDate = kst(now());
            acct.inventory.acquired.push(row);
          }
          return {
            // `noCode: true`: claimed, and SOOP has no code to show (it went to a game account).
            itemCode: row.noCode ? "" : row.claimCode || "FAKE-" + key,
            itemType: row.itemType,
            itemName: row.itemName,
            dropsName: "Fake drops event",
            gameTitle: "Fake game",
            renewFlag: row.renewFlag || "N",
            itemDescription: "Redeem at <b>example.test</b><br>within 30 days",
          };
        },
        openBridge,
      };
    },
  };
  return world;
}

module.exports = { createFakeSoop };
