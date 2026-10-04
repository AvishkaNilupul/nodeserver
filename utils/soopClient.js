/* global fetch, AbortSignal, setInterval, clearInterval */
// Shared SOOP (ex-AfreecaTV) client: cookie parsing, the read-only drops APIs,
// and the bridge watch socket. Ported from the probe in _soop-probe/soop.js,
// whose protocol was verified live (4 minutes watched => 4 minutes credited).
//
// Watch time is credited solely by holding wss://bridge.sooplive.com/Websocket
// (subprotocol "bridge"): INIT_GW -> CERTTICKETEX -> INIT_BROAD -> KEEPALIVE
// every 20 s. No browser, video or chat is involved.
const crypto = require("crypto");
const WebSocket = require("ws");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

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

  async function api(url, opt = {}) {
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
  const joinLog = (extra = []) =>
    `log\u0011${kv([
      ["uuid", ck._au],
      ["geo_cc", "JP"],
      ["geo_rc", "13"],
      ["acpt_lang", "en_US"],
      ["svc_lang", "en_US"],
      ["is_iframeapi", "false"],
      ["content_lang", "ko_KR"],
      ["join_cc", "392"],
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
      },
    );
    const send = (SVC, DATA) => {
      if (ws.readyState === 1)
        ws.send(JSON.stringify({ SVC, RESULT: 0, DATA }));
    };
    const state = { joined: false, closed: false, stop: null };
    ws.on("open", () => {
      hooks.onEvent && hooks.onEvent("open");
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
        JOINLOG: joinLog(),
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
          JOINLOG: joinLog([
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
