// In-memory SOOP for tests and the dev harness (contract §12). No network.
//
// `world.clientFor` hands back the §7 client shape, so it can be given straight
// to farm.setClientFactory. The world reproduces the rules that matter to the
// farm: watch time is credited only through a joined bridge on an on-air channel
// of a LIVE campaign, from a country SOOP pays in, when the claimed country is
// the one the connection is seen from (§4). A delisted campaign leaves the
// event list but its missions keep counting, as on the real site.
const crypto = require("crypto");
const { SoopError } = require("../../utils/soop/errors");
const { creditStatus } = require("../../utils/soop/geo");

const DIVISIONS = ["available", "acquired", "expired"];
const METHODS =
  "privateInfo missions campaigns campaignsAll liveInfo categoryChannels inventoryCounts inventory openBridge".split(" ");
const DAY = 24 * 3600 * 1000;
const clone = (v) => JSON.parse(JSON.stringify(v));
const cc = (v) => (v ? String(v).trim().toUpperCase() : null);
// SOOP timestamps are Korea wall-clock strings with no zone.
const kst = (ms) =>
  new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");

function createFakeSoop({ now = Date.now } = {}) {
  const accounts = new Map(); // id -> account
  const tickets = new Map(); // AuthTicket value -> id
  const campaigns = new Map(); // dropsIdx -> raw row (insertion order = list order)
  const delisted = new Set();
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
      ch = { id: key, nick: key, onAir: false, cateNo: null, bno: null };
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
        idx: String(++seq),
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

    advance(minutes = 1) {
      const credited = [];
      if (egress.down) return credited;
      const seen = new Set();
      for (const b of open) {
        const acct = accounts.get(b.id);
        const ch = channels.get(b.channel);
        if (!b.state.joined || !acct || !acct.loggedIn || !ch || !ch.onAir) continue;
        const country = seenCountry(acct);
        if (b.claimedCountry !== country || creditStatus(country) !== "yes") continue;
        for (const row of campaigns.values()) {
          const key = `${acct.id}|${row.dropsIdx}`;
          if (!row.live || !covers(row, ch) || seen.has(key)) continue;
          seen.add(key);
          const total = (acct.minutes.get(row.dropsIdx) || 0) + Number(minutes);
          acct.minutes.set(row.dropsIdx, total);
          credited.push({ id: acct.id, dropsIdx: row.dropsIdx, minutes: total });
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
      };
      const listed = (filter) =>
        [...campaigns.values()]
          .filter((r) => r.filter === filter && !delisted.has(r.dropsIdx))
          .map((r) => ({ ...clone(r), filter }));

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
          return listed(filter);
        },
        async campaignsAll() {
          enter("campaignsAll", false);
          return [...listed("progress"), ...listed("scheduled")];
        },
        async liveInfo(bj) {
          enter("liveInfo", false);
          const ch = channels.get(String(bj));
          if (!ch || !ch.onAir) return { RESULT: 0 };
          const gates = { GWIP: "10.0.0.1", GWPT: "8001", CTIP: "10.0.0.2", CTPT: "8002" };
          return {
            ...{ RESULT: 1, BJID: ch.id, BJNICK: ch.nick, BNO: ch.bno },
            ...{ CATE: ch.cateNo || "00130000", FTK: `fake-ftk-${ch.id}`, ...gates },
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
          return from.flatMap((d) => clone(acct.inventory[d]));
        },
        openBridge,
      };
    },
  };
  return world;
}

module.exports = { createFakeSoop };
