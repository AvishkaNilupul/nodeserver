/* global fetch, AbortSignal, setInterval, clearInterval */
// Shared SOOP (ex-AfreecaTV) client: cookie parsing, the read-only drops APIs,
// and the bridge watch socket. Ported from the probe in _soop-probe/soop.js,
// whose protocol was verified live (4 minutes watched => 4 minutes credited).
//
// Watch time is credited solely by holding wss://bridge.sooplive.com/Websocket
// (subprotocol "bridge"): INIT_GW -> CERTTICKETEX -> INIT_BROAD -> KEEPALIVE
// every 20 s. No browser, video or chat is involved.
const crypto = require("crypto");
const https = require("https");
const WebSocket = require("ws");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

// SOOP only credits watch time to viewers in supported countries (measured
// 2026-10-04: a Tokyo residential IP credits, the US server and a Sri Lankan
// residential IP do not). SOOP_PROXY_URL points every SOOP HTTP call and the
// bridge socket at a SOCKS5 egress — an `ssh -D` tunnel to a host in a
// supported country — so the farm leaves from an address that can earn.
const PROXY_URL = process.env.SOOP_PROXY_URL || "";
let proxyAgent = null;
if (PROXY_URL) {
  try {
    // Required lazily: without a proxy configured this optional package must
    // never be able to stop the app from booting.
    const { SocksProxyAgent } = require("socks-proxy-agent");
    proxyAgent = new SocksProxyAgent(PROXY_URL);
  } catch (err) {
    console.error(
      "[soop] SOOP_PROXY_URL is set but no proxy agent could be built:",
      err.message,
    );
  }
}

// Accepts a Cookie-Editor JSON array, a {name:value} object, or a raw
// "a=b; c=d" header. Returns [{ name, value }].
function parseCookieInput(text) {
  const t = String(text || "").trim();
  if (!t) throw new Error("empty cookie input");
  if (t.startsWith("[")) {
    return JSON.parse(t).map((c) => ({ name: c.name, value: c.value }));
  }
  if (t.startsWith("{")) {
    const o = JSON.parse(t);
    if (o.name && o.value) return [{ name: o.name, value: o.value }];
    return Object.entries(o).map(([name, value]) => ({
      name,
      value: String(value),
    }));
  }
  return t
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf("=");
      return i < 0
        ? null
        : { name: s.slice(0, i).trim(), value: s.slice(i + 1).trim() };
    })
    .filter(Boolean);
}

function makeClient(cookies, source) {
  const ck = Object.fromEntries(cookies.map((c) => [c.name, c.value]));
  if (!ck.AuthTicket) {
    throw new Error("no AuthTicket in cookie set (logged-out export?)");
  }
  ck._au = ck._au || crypto.randomBytes(16).toString("hex");
  ck._au3rd = ck._au3rd || ck._au;
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const H = {
    cookie: cookieHeader,
    "user-agent": UA,
    origin: "https://play.sooplive.com",
    referer: "https://play.sooplive.com",
  };

  // fetch() cannot be given a SOCKS agent, so when an egress proxy is set the
  // same request goes out over https.request instead (same headers, same
  // 20 s budget, same JSON-or-throw contract).
  function proxiedJson(url, opt = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const headers = { ...H, ...(opt.headers || {}) };
      // fetch() accepts a URLSearchParams body; https.request only writes
      // strings and Buffers, so flatten it and state its length.
      let body = null;
      if (opt.body != null) {
        body =
          typeof opt.body === "string" || Buffer.isBuffer(opt.body)
            ? opt.body
            : String(opt.body);
        headers["content-length"] = Buffer.byteLength(body);
      }
      const req = https.request(
        {
          host: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          method: opt.method || "GET",
          headers,
          agent: proxyAgent,
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(
                new Error(
                  `${url} -> HTTP ${res.statusCode}: ${body.slice(0, 160)}`,
                ),
              );
            }
          });
        },
      );
      req.setTimeout(20000, () => req.destroy(new Error(`${url} -> timeout`)));
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  async function api(url, opt = {}) {
    if (proxyAgent) return proxiedJson(url, opt);
    const r = await fetch(url, {
      ...opt,
      headers: { ...H, ...(opt.headers || {}) },
      signal: AbortSignal.timeout(20000),
    });
    const t = await r.text();
    try {
      return JSON.parse(t);
    } catch {
      throw new Error(`${url} -> HTTP ${r.status}: ${t.slice(0, 160)}`);
    }
  }

  const privateInfo = () =>
    api("https://afevent2.sooplive.com/api/get_private_info.php", {
      referer: "https://www.sooplive.com/",
    });

  // Inventory (drops.sooplive.com). Counts per division: available/acquired/expired.
  const inventoryCounts = async () => {
    const j = await api(
      "https://drops.sooplive.com/api/get_drops_division.php",
      {
        origin: "https://drops.sooplive.com",
        referer: "https://drops.sooplive.com/inventory",
      },
    );
    if (j.result !== 1) throw new Error(j.message || "inventory unavailable");
    return j.data || {};
  };

  async function inventory(division = null, pages = 5) {
    const out = [];
    for (let p = 1; p <= pages; p++) {
      const j = await api("https://drops.sooplive.com/api/get_drops_list.php", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://drops.sooplive.com",
        },
        referer: "https://drops.sooplive.com/inventory",
        body: JSON.stringify({ pageNo: p, prePageNo: 20, division }),
      });
      if (j.result !== 1) throw new Error(j.message || "inventory unavailable");
      const rows = j.data || [];
      out.push(...rows);
      if (!rows.length || out.length >= Number(j.totalCount || 0)) break;
    }
    return out;
  }

  // The list endpoint filters by division but does not label each row, so tag them.
  async function inventoryTagged() {
    const out = [];
    for (const d of ["available", "acquired", "expired"]) {
      for (const row of await inventory(d)) out.push({ ...row, division: d });
    }
    return out;
  }

  const missions = async () => {
    const j = await api(
      "https://drops.sooplive.com/api/get_drops_mission_list.php",
      {
        referer: "https://drops.sooplive.com/mission",
      },
    );
    if (j.result !== 1)
      throw new Error(j.message || "mission list unavailable");
    return j.data || [];
  };

  async function campaigns(filter = "progress") {
    const seen = [];
    for (let p = 1; p <= 30; p++) {
      const body = JSON.stringify({
        filter,
        gameIdx: "all",
        prePageNo: p,
        pageNo: p,
      });
      const j = await api(
        "https://drops.sooplive.com/api/get_drops_event_list.php",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        },
      );
      if (j.result !== 1) {
        throw new Error(j.message || "campaign list unavailable");
      }
      const rows = j.data || [];
      if (!rows.length) break;
      seen.push(...rows);
    }
    return [
      ...new Map(
        seen.map((e) => [e.dropsIdx, { ...e, filter: e.filter || filter }]),
      ).values(),
    ];
  }

  // progress = running/ended-listing, scheduled = announced but not started.
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
    const body = new URLSearchParams({
      bid: bj,
      bno,
      type: "live",
      pwd: "",
      player_type: "html5",
      stream_type: "common",
      quality: "HD",
      mode: "landing",
      from_api: "0",
      is_revive: "false",
    });
    const j = await api(
      `https://live.sooplive.com/afreeca/player_live_api.php?bjid=${encodeURIComponent(bj)}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        referer: `https://play.sooplive.com/${encodeURIComponent(bj)}`,
        body,
      },
    );
    return j.CHANNEL;
  }

  // Top live channel in a category (for category-wide campaigns).
  async function categoryChannel(cateNo) {
    const j = await api(
      `https://live.sooplive.com/api/main_broad_list_api.php?selectType=cate&selectValue=${encodeURIComponent(cateNo)}&orderType=view_cnt&pageNo=1`,
      { referer: "https://www.sooplive.com/" },
    );
    const b = (j.broad || [])[0];
    return b ? b.user_id : null;
  }

  const kv = (pairs) =>
    pairs.map(([k, v]) => `\u0006&\u0006${k}\u0006=\u0006${v}`).join("");

  // What the viewer claims about where they are. SOOP refuses to credit watch
  // time when that claim disagrees with the IP it sees: measured 2026-10-04,
  // one Japanese IP earned 0 minutes in 10 while claiming US geo and 9 minutes
  // in 10 while claiming JP — same account, campaign and minute. Sri Lanka
  // through the Pi was the same story: 0 minutes claiming JP, 10 minutes in 10
  // once it claimed LK. So the claim is read back from SOOP itself: the country
  // it reports for this connection is the country we say we are in.
  const GEO_RC = process.env.SOOP_GEO_RC || "13";
  const JOIN_CC = process.env.SOOP_JOIN_CC || "392";
  let geoClaim = null;
  async function geoCountry() {
    if (process.env.SOOP_GEO_CC) return process.env.SOOP_GEO_CC;
    if (!geoClaim) {
      let cc = "JP";
      try {
        const p = await privateInfo();
        cc = (p.CHANNEL && p.CHANNEL.COUNTRY_CODE) || cc;
      } catch {
        // keep the fallback rather than failing the watch session
      }
      geoClaim = cc;
    }
    return geoClaim;
  }

  const joinLog = (cc, extra = []) =>
    `log\u0011${kv([
      ["uuid", ck._au],
      ["geo_cc", cc],
      ["geo_rc", GEO_RC],
      ["acpt_lang", "en_US"],
      ["svc_lang", "en_US"],
      ["is_iframeapi", "false"],
      ["content_lang", "ko_KR"],
      ["join_cc", JOIN_CC],
      ["os", "mac"],
      ["is_streamer", "false"],
      ["is_rejoin", "false"],
      ["is_auto", "false"],
      ["is_support_adaptive", "true"],
      ["uuid_3rd", ck._au3rd],
      ["subscribe", "0"],
      ["player_mode", "landing"],
      ["sub_view_type", "non_sub"],
      ...extra,
    ])}` +
    `\u0012liveualog\u0011${kv([
      ["is_clearmode", "false"],
      ["lowlatency", "0"],
      ["is_streamer", "false"],
      ["os", "mac"],
    ])}\u0012`;

  // Holds the bridge socket, the only thing watch time is credited from.
  function openBridge(bj, ch, hooks = {}) {
    const guid = crypto.randomBytes(16).toString("hex").toUpperCase();
    const ws = new WebSocket(
      "wss://bridge.sooplive.com/Websocket",
      ["bridge"],
      {
        headers: { "user-agent": UA, origin: "https://play.sooplive.com" },
        ...(proxyAgent ? { agent: proxyAgent } : {}),
      },
    );
    const send = (SVC, DATA) => {
      if (ws.readyState === 1)
        ws.send(JSON.stringify({ SVC, RESULT: 0, DATA }));
    };
    const state = { joined: false, closed: false, stop: null };
    // Filled in on open; the INIT_BROAD reply reuses the same claim.
    let cc = "JP";
    ws.on("open", async () => {
      hooks.onEvent && hooks.onEvent("open");
      cc = await geoCountry();
      send("INIT_GW", {
        gate_ip: ch.GWIP,
        gate_port: Number(ch.GWPT),
        broadno: Number(ch.BNO),
        category: ch.CATE,
        fanticket: ch.FTK,
        cookie: ck.AuthTicket,
        cli_type: 44,
        cc_cli_type: 19,
        QUALITY: "ori",
        guid,
        BJID: bj,
        addinfo: "ad_lang\u0011en\u0012is_auto\u00110\u0012",
        JOINLOG: joinLog(cc),
        update_info: 0,
      });
    });
    ws.on("message", (m) => {
      let j;
      try {
        j = JSON.parse(m.toString());
      } catch {
        return;
      }
      if (j.SVC === "CERTTICKETEX") {
        send("INIT_BROAD", {
          center_ip: ch.CTIP,
          center_port: Number(ch.CTPT),
          passwd: "",
          JOINLOG: joinLog(cc, [
            ["path1", "etc"],
            ["is_embed", "false"],
          ]),
          cli_type: 44,
          cc_cli_type: 19,
          QUALITY: "ori",
          guid,
          gw_ticket: j.DATA.pcTicket,
          append_data: j.DATA.pcAppendDat,
        });
      } else if (j.SVC === "JOINCH_COMMON") {
        state.joined = true;
        hooks.onEvent && hooks.onEvent("joined");
      } else if (j.SVC === "CLOSECH" || j.SVC === "CLOSEBROAD") {
        hooks.onEvent && hooks.onEvent("server-close:" + j.SVC);
      }
    });
    ws.on("close", () => {
      state.closed = true;
      hooks.onEvent && hooks.onEvent("closed");
    });
    ws.on("error", (e) => {
      hooks.onEvent && hooks.onEvent("error:" + e.message);
    });
    const iv = setInterval(() => send("KEEPALIVE", {}), 20000);
    state.stop = () => {
      clearInterval(iv);
      try {
        ws.close();
      } catch {
        // closing a dead socket must never throw out of the caller
      }
    };
    return state;
  }

  return {
    source,
    ck,
    cookies,
    privateInfo,
    missions,
    campaigns,
    campaignsAll,
    liveInfo,
    categoryChannel,
    openBridge,
    inventory,
    inventoryTagged,
    inventoryCounts,
  };
}

module.exports = { UA, parseCookieInput, makeClient };
