/* global setInterval, clearInterval */
// Shared SOOP (ex-AfreecaTV) client (contract §7): cookie parsing, the
// read-only drops APIs, and the bridge watch socket. The protocol was verified
// live by the probe in _soop-probe/ (4 minutes watched => 4 minutes credited).
//
// Watch time is credited solely by holding wss://bridge.sooplive.com/Websocket
// (subprotocol "bridge"): INIT_GW -> CERTTICKETEX -> INIT_BROAD -> KEEPALIVE
// every 20 s. No browser, video or chat is involved.
//
// Nothing here logs. Cookies and the AuthTicket leave this file only inside
// requests to SOOP; the client object does not expose them.
const crypto = require("crypto");
const { SoopError, LOGIN_RE } = require("./soop/errors");
const { getTransport } = require("./soop/http");
const { createGeoResolver } = require("./soop/geo");
const { normalizeMission } = require("./soop/normalize");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

const DROPS = "https://drops.sooplive.com";
const PLAY = "https://play.sooplive.com";
const BRIDGE_URL = "wss://bridge.sooplive.com/Websocket";
const CAMPAIGN_PAGE_CAP = 80;
// 20 rows a page. v1 stopped at 5 pages, which silently truncated a division
// above 100 items; the loop still ends at SOOP's own totalCount.
const INVENTORY_PAGE_CAP = 25;
const KEEPALIVE_MS = 20000;
const TICKET_RE = /(^|[;\s])AuthTicket\s*=/;

// Accepts a Cookie-Editor JSON array, a {name:value} object, or a raw
// "a=b; c=d" header. Returns [{ name, value }].
function parseCookieInput(text) {
  const t = String(text || "").trim();
  if (!t) throw new Error("empty cookie input");
  if (t.startsWith("[") || t.startsWith("{")) {
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      // JSON.parse quotes a slice of its input in the message; that slice
      // would be cookie text.
      throw new Error("cookie input is not valid JSON");
    }
    if (Array.isArray(o)) {
      return o.filter((c) => c && typeof c === "object").map((c) => ({ name: c.name, value: c.value }));
    }
    if (o.name && o.value) return [{ name: o.name, value: o.value }];
    return Object.entries(o).map(([name, value]) => ({ name, value: String(value) }));
  }
  return t
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf("=");
      return i < 0 ? null : { name: s.slice(0, i).trim(), value: s.slice(i + 1).trim() };
    })
    .filter(Boolean);
}

// Index just past the JSON value opening at `start` (brackets inside strings
// do not count). An unterminated value runs to the end of the text.
function jsonEnd(t, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "[" || c === "{") depth++;
    else if ((c === "]" || c === "}") && --depth === 0) return i + 1;
  }
  return t.length;
}

// Text between JSON exports: every line holding an AuthTicket is one account.
// Other name=value lines belong to the ticket above them (or to the first one).
function looseExports(text) {
  const groups = [];
  const lead = [];
  for (const line of text.split(/\r?\n/).map((s) => s.trim())) {
    if (TICKET_RE.test(line)) groups.push([...lead.splice(0), line]);
    else if (line.includes("=")) (groups[groups.length - 1] || lead).push(line);
  }
  return groups.map((g) => g.join("\n"));
}

// Bulk paste: several Cookie-Editor JSON arrays one after another and/or lines
// of "AuthTicket=…". One entry per account, in paste order; each entry is fed
// to parseCookieInput by the caller. A single export comes back as [text].
function splitCookieExports(text) {
  const t = String(text == null ? "" : text).trim();
  if (!t) return [];
  const out = [];
  let loose = "";
  let i = 0;
  while (i < t.length) {
    const c = t[i];
    // A JSON export starts a line (or follows another export); a bracket in
    // the middle of a cookie header line is just part of a value.
    const lineSoFar = loose.slice(loose.lastIndexOf("\n") + 1);
    if ((c === "[" || c === "{") && /^[\s,]*$/.test(lineSoFar)) {
      const end = jsonEnd(t, i);
      out.push(...looseExports(loose), t.slice(i, end));
      loose = "";
      i = end;
    } else {
      loose += c;
      i++;
    }
  }
  out.push(...looseExports(loose));
  return out.length ? out : [t];
}

// One geo resolver per process: the country belongs to the egress, not the account.
let geoSingleton = null;
function sharedGeo() {
  if (!geoSingleton) geoSingleton = createGeoResolver();
  return geoSingleton;
}

// Runs fn and swallows a throw: a listener's bug or a dying socket must never
// surface in the caller (a socket reports itself through "error" / "close").
// prettier-ignore
const quiet = (fn) => { try { return fn(); } catch { return undefined; } };

const kv = (pairs) => pairs.map(([k, v]) => `\u0006&\u0006${k}\u0006=\u0006${v}`).join("");

// prettier-ignore
function makeClient(cookies, {
  id = null, transport = getTransport(), geo = sharedGeo(), lang = "en-US,en;q=0.9",
  WebSocketImpl = require("ws"),
} = {}) {
  const list = Array.isArray(cookies) ? cookies : [];
  const ck = Object.fromEntries(list.map((c) => [c.name, c.value]));
  if (!ck.AuthTicket) {
    throw new SoopError("no AuthTicket in cookie set (logged-out export?)", { code: "AUTH" });
  }
  ck._au = ck._au || crypto.randomBytes(16).toString("hex");
  ck._au3rd = ck._au3rd || ck._au;
  const cookieHeader = list.map((c) => `${c.name}=${c.value}`).join("; ");

  // Every header goes inside `headers`. v1 passed origin / referer beside it,
  // where they were ignored, so the drops site saw the player's origin.
  function api(url, { method = "GET", headers = {}, body = null, referer } = {}) {
    const site = url.startsWith(DROPS + "/") ? DROPS : PLAY;
    return transport.requestJson(url, {
      method,
      // prettier-ignore
      headers: {
        cookie: cookieHeader, "user-agent": UA, "accept-language": lang,
        origin: site, referer: referer || site, ...headers,
      },
      body,
    });
  }

  const postJson = (path, referer, payload) =>
    api(DROPS + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      referer: DROPS + referer,
      body: JSON.stringify(payload),
    });

  // The drops API answers { result: 1, data } or a refusal with a message.
  function ok(j, what) {
    if (j && j.result === 1) return j;
    const message = String((j && j.message) || `${what} unavailable`);
    const auth = (j && Number(j.result) === -1) || LOGIN_RE.test(message);
    throw new SoopError(message, { code: auth ? "AUTH" : "API" });
  }

  // Who SOOP thinks this session is, and the country it sees the request come
  // from. A logged-out session is an answer here, not an error.
  async function privateInfo() {
    const j = await api("https://afevent2.sooplive.com/api/get_private_info.php");
    const c = (j && j.CHANNEL) || {};
    return {
      loggedIn: Number(c.IS_LOGIN) === 1,
      loginId: String(c.LOGIN_ID || "").trim() || null,
      nick: c.LOGIN_NICK || null,
      country: c.COUNTRY_CODE || null,
    };
  }

  async function missions() {
    const j = await api(`${DROPS}/api/get_drops_mission_list.php`, { referer: `${DROPS}/mission` });
    return (ok(j, "mission list").data || []).map(normalizeMission);
  }

  // One event per page; the list ends at the first empty page.
  async function campaigns(filter = "progress") {
    const seen = [];
    for (let p = 1; p <= CAMPAIGN_PAGE_CAP; p++) {
      const body = { filter, gameIdx: "all", prePageNo: p, pageNo: p };
      const j = await postJson("/api/get_drops_event_list.php", "/", body);
      const rows = ok(j, "campaign list").data || [];
      if (!rows.length) break;
      seen.push(...rows);
    }
    const tagged = seen.map((e) => [e.dropsIdx, { ...e, filter: e.filter || filter }]);
    return [...new Map(tagged).values()];
  }

  // progress = running/ended-listing, scheduled = announced but not started.
  // One list failing does not hide the other; both failing rethrows the first.
  async function campaignsAll() {
    const out = [];
    let firstErr = null;
    for (const f of ["progress", "scheduled"]) {
      try {
        out.push(...(await campaigns(f)));
      } catch (e) {
        if (!firstErr) firstErr = e;
      }
    }
    if (!out.length && firstErr) throw firstErr;
    return [...new Map(out.map((e) => [e.dropsIdx, e])).values()];
  }

  async function liveInfo(bj, bno = "") {
    // prettier-ignore
    const body = new URLSearchParams({
      bid: bj, bno, type: "live", pwd: "", player_type: "html5", stream_type: "common",
      quality: "HD", mode: "landing", from_api: "0", is_revive: "false",
    });
    const j = await api(
      `https://live.sooplive.com/afreeca/player_live_api.php?bjid=${encodeURIComponent(bj)}`,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body },
    );
    return (j && j.CHANNEL) || null;
  }

  // Live channels in a category, most viewers first (for category-wide campaigns).
  async function categoryChannels(cateNo, limit = 5) {
    const j = await api(
      `https://live.sooplive.com/api/main_broad_list_api.php?selectType=cate&selectValue=${encodeURIComponent(cateNo)}&orderType=view_cnt&pageNo=1`,
    );
    const ids = ((j && j.broad) || []).map((b) => b && b.user_id).filter(Boolean);
    return [...new Set(ids.map(String))].slice(0, Math.max(0, limit));
  }

  async function inventoryCounts() {
    const j = await api(`${DROPS}/api/get_drops_division.php`, { referer: `${DROPS}/inventory` });
    const d = ok(j, "inventory").data || {};
    const n = (v) => Number(v) || 0;
    return { available: n(d.available), acquired: n(d.acquired), expired: n(d.expired) };
  }

  // The list endpoint filters by division but does not label its rows.
  async function inventory(division = null) {
    const out = [];
    for (let p = 1; p <= INVENTORY_PAGE_CAP; p++) {
      const body = { pageNo: p, prePageNo: 20, division };
      const j = await postJson("/api/get_drops_list.php", "/inventory", body);
      const rows = ok(j, "inventory").data || [];
      out.push(...rows);
      if (!rows.length || out.length >= Number(j.totalCount || 0)) break;
    }
    return out;
  }

  // SOOP's "Claim" and "Check info" are the same call: on an unclaimed reward it
  // CLAIMS it (cannot be undone); on a claimed one it only reads. The reply
  // carries the code or link in `itemCode` — the inventory list never does.
  async function useInfo(itemCodeIdx) {
    const j = await postJson("/api/get_drops_use_info.php", "/inventory", { itemCodeIdx });
    if (j && j.data) return j.data;
    const message = String((j && j.message) || "reward info unavailable");
    const auth = (j && Number(j.result) === -1) || LOGIN_RE.test(message);
    throw new SoopError(message, { code: auth ? "AUTH" : "API" });
  }

  // What the viewer claims about where they are. SOOP refuses to credit watch
  // time when the claim disagrees with the IP it sees (measured 2026-10-04:
  // one Japanese IP earned 0 minutes in 10 claiming US and 9 in 10 claiming
  // JP), so `claim` is what the geo resolver read back from SOOP itself.
  // prettier-ignore
  const joinLog = (claim, extra = []) =>
    `log\u0011${kv([
      ["uuid", ck._au], ["geo_cc", claim.cc], ["geo_rc", claim.geoRc],
      ["acpt_lang", "en_US"], ["svc_lang", "en_US"], ["is_iframeapi", "false"],
      ["content_lang", "ko_KR"], ["join_cc", claim.joinCc], ["os", "mac"],
      ["is_streamer", "false"], ["is_rejoin", "false"], ["is_auto", "false"],
      ["is_support_adaptive", "true"], ["uuid_3rd", ck._au3rd], ["subscribe", "0"],
      ["player_mode", "landing"], ["sub_view_type", "non_sub"],
      ...extra,
    ])}` +
    `\u0012liveualog\u0011${kv([
      ["is_clearmode", "false"], ["lowlatency", "0"], ["is_streamer", "false"], ["os", "mac"],
    ])}\u0012`;

  // Holds the bridge socket, the only thing watch time is credited from.
  // state.error: "egress" no usable egress (no socket was opened) · "geo" the
  // country could not be read (never joined) · "socket" the socket reported one.
  function openBridge(bj, channel, { onEvent } = {}) {
    const ch = channel || {};
    const state = { joined: false, closed: false, error: null, stop: () => {} };
    const emit = (ev) => quiet(() => typeof onEvent === "function" && onEvent(ev));
    let ws;
    try {
      ws = new WebSocketImpl(BRIDGE_URL, ["bridge"], {
        headers: { "user-agent": UA, origin: PLAY },
        ...transport.wsOptions(),
      });
    } catch {
      // Fail closed: without the egress there is no direct fallback.
      state.error = "egress";
      state.closed = true;
      return state;
    }
    const guid = crypto.randomBytes(16).toString("hex").toUpperCase();
    const send = (SVC, DATA) =>
      quiet(() => ws.readyState === 1 && ws.send(JSON.stringify({ SVC, RESULT: 0, DATA })));
    let claim = null; // filled in on open; the INIT_BROAD reply reuses it
    let stopped = false;
    const iv = setInterval(() => send("KEEPALIVE", {}), KEEPALIVE_MS);
    if (iv && typeof iv.unref === "function") iv.unref();
    state.stop = () => {
      stopped = true;
      clearInterval(iv);
      quiet(() => ws.close());
    };
    ws.on("open", async () => {
      emit("open");
      try {
        claim = await geo.get(async () => (await privateInfo()).country);
      } catch {
        // Joining with a guessed country earns nothing and looks like farming.
        state.error = "geo";
        emit("error:geo");
        state.stop();
        return;
      }
      if (stopped) return;
      // prettier-ignore
      send("INIT_GW", {
        gate_ip: ch.GWIP, gate_port: Number(ch.GWPT), broadno: Number(ch.BNO),
        category: ch.CATE, fanticket: ch.FTK, cookie: ck.AuthTicket,
        cli_type: 44, cc_cli_type: 19, QUALITY: "ori", guid, BJID: bj,
        addinfo: "ad_lang\u0011en\u0012is_auto\u00110\u0012",
        JOINLOG: joinLog(claim),
        update_info: 0,
      });
    });
    ws.on("message", (m) => {
      const j = quiet(() => JSON.parse(m.toString()));
      if (!j || typeof j !== "object") return;
      if (j.SVC === "CERTTICKETEX") {
        if (!claim) return;
        const data = j.DATA || {};
        // prettier-ignore
        send("INIT_BROAD", {
          center_ip: ch.CTIP, center_port: Number(ch.CTPT), passwd: "",
          JOINLOG: joinLog(claim, [["path1", "etc"], ["is_embed", "false"]]),
          cli_type: 44, cc_cli_type: 19, QUALITY: "ori", guid,
          gw_ticket: data.pcTicket, append_data: data.pcAppendDat,
        });
      } else if (j.SVC === "JOINCH_COMMON") {
        state.joined = true;
        emit("joined");
      } else if (j.SVC === "CLOSECH" || j.SVC === "CLOSEBROAD") {
        emit("server-close:" + j.SVC);
      }
    });
    ws.on("close", () => {
      state.closed = true;
      clearInterval(iv);
      emit("closed");
    });
    ws.on("error", (e) => {
      state.error = state.error || "socket";
      emit("error:" + ((e && e.message) || "socket"));
    });
    return state;
  }

  // prettier-ignore
  return {
    id, privateInfo, missions, campaigns, campaignsAll, liveInfo, categoryChannels,
    inventoryCounts, inventory, useInfo, openBridge,
  };
}

module.exports = { UA, parseCookieInput, splitCookieExports, makeClient, sharedGeo };
