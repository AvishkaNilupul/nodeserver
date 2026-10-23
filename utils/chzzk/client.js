// Narrow CHZZK API client (docs/CHZZK-FARM.md §6).
//
// One factory, `makeClient`, hands out an object whose methods name the
// handful of CHZZK endpoints the farm uses. The transport is injected (tests
// pass a fake); the client only shapes requests, judges answers, and returns
// the normalised payloads named in §6.
//
// Nothing here logs: cookies and coupon codes leave this file only inside the
// outbound CHZZK request. ChzzkError messages carry no cookie value and no
// code — untrusted CHZZK message text is treated as data.

const { ChzzkError } = require("./errors");
const { getTransport } = require("./http");
const { toHeader, deviceIdOf } = require("./cookies");
const { kst, liveRow } = require("./normalize");

const API = "https://api.chzzk.naver.com";
const GAME = "https://comm-api.game.naver.com";
const HOME = "https://chzzk.naver.com";
const IPINFO = "https://ipinfo.io/json";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const ACCEPT = "application/json, text/plain, */*";
const ACCEPT_LANG = "ko-KR,ko;q=0.9,en;q=0.8";

const str = (v) => (v == null ? "" : String(v));
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function makeClient({ cookies = null, deviceId = "", transport = getTransport() } = {}) {
  const loggedIn = cookies != null;
  const cookieHeader = loggedIn ? toHeader(cookies) : "";
  const dev = String(deviceId || (loggedIn ? deviceIdOf(cookies) : ""));

  // The header kit every CHZZK endpoint (not ipinfo) carries. The browser's
  // web player sets these without exception; CHZZK refuses some endpoints
  // when they are missing. `referer` is the live page for live-scoped calls.
  function chzzkHeaders(referer) {
    const h = {
      "user-agent": UA,
      accept: ACCEPT,
      "accept-language": ACCEPT_LANG,
      origin: HOME,
      referer: referer || `${HOME}/`,
      "front-client-product-type": "web",
      "front-client-platform-type": "PC",
    };
    // The web player's header is literally "deviceId" (_chzzk-probe/HANDOFF.md §3).
    if (dev) h.deviceid = dev;
    if (cookieHeader) h.cookie = cookieHeader;
    return h;
  }

  // What to do with a CHZZK answer. On success returns the raw body.content
  // (or null for a 204 / empty 2xx); on failure throws a coded ChzzkError.
  // Order matches §6: AUTH takes precedence, then 204, then body.code, then
  // the status-based HTTP fallback.
  function judge(res) {
    const { status, json } = res;
    if (status === 401) {
      throw new ChzzkError("Not logged in", { code: "AUTH", status });
    }
    if (status === 403 && json && Number(json.code) === 30001) {
      throw new ChzzkError("Not logged in", { code: "AUTH", status });
    }
    if (status === 204) return null;
    if (json && Number(json.code) === 200) return json.content;
    if (json && json.code != null) {
      throw new ChzzkError(str(json.message) || `code ${json.code}`, {
        code: "API",
        status,
      });
    }
    if (status >= 400) {
      throw new ChzzkError(`unexpected status ${status}`, {
        code: "HTTP",
        status,
      });
    }
    // 2xx without a body.code (watchEvent 200, polls, …): empty success.
    return null;
  }

  // The player's polling calls carry these (seen in the probe that earned
  // minutes, _chzzk-probe/watch.js); sent on live-status and watch-event.
  const POLLING = {
    "If-Modified-Since": "Mon, 26 Jul 1997 05:00:00 GMT",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };

  // Send a CHZZK request with the standard header kit. `extra` adds endpoint-
  // specific headers (e.g. `scene` on watchEvent). An object body is sent as
  // JSON — the transport adds Content-Type when `content-type` is unset.
  async function send(url, { method = "GET", body = null, referer = null, extra = null } = {}) {
    const headers = chzzkHeaders(referer);
    if (extra) Object.assign(headers, extra);
    const res = await transport.request(url, { method, headers, body });
    return judge(res);
  }

  // Logged-in-only calls refuse early on an anonymous client — no request
  // leaves the process, so the fail-closed egress rule still holds.
  function requireLogin() {
    if (!loggedIn) {
      throw new ChzzkError("Not logged in", { code: "AUTH" });
    }
  }

  // ------------------------------------------------------------------- user
  async function userStatus() {
    requireLogin();
    const c = (await send(`${GAME}/nng_main/v1/user/getUserStatus`)) || {};
    if (!c.loggedIn) {
      throw new ChzzkError("Not logged in", { code: "AUTH" });
    }
    return {
      loggedIn: true,
      userIdHash: str(c.userIdHash),
      nickname: str(c.nickname),
      penalties: Array.isArray(c.penalties) ? c.penalties : [],
    };
  }

  // ------------------------------------------------------------- categories
  // CHZZK pages its live-categories list with an opaque "next" cursor (the
  // last row's { concurrentUserCount, categoryId } by observation). The
  // caller passes the previous page's `next` back in as-is.
  async function categoriesLive(next = null) {
    const params = new URLSearchParams({ size: "50" });
    if (next && typeof next === "object") {
      for (const [k, v] of Object.entries(next)) {
        if (v != null && v !== "") params.set(k, String(v));
      }
    }
    const c = await send(`${API}/service/v1/categories/live?${params}`);
    const data = c && Array.isArray(c.data) ? c.data : [];
    const rows = data
      .filter((r) => r && typeof r === "object")
      .map((r) => ({
        categoryType: str(r.categoryType),
        categoryId: str(r.categoryId),
        categoryValue: str(r.categoryValue),
        openLiveCount: num(r.openLiveCount),
        dropsCampaignNos: Array.isArray(r.dropsCampaignNos)
          ? r.dropsCampaignNos.map(num).filter((n) => n > 0)
          : [],
      }));
    const page = c && c.page;
    const nextCursor =
      page && typeof page === "object" && page.next != null ? page.next : null;
    return { rows, next: nextCursor };
  }

  // --------------------------------------------------------------- campaign
  async function campaign(no) {
    return send(`${API}/service/v2/drops/campaigns/${encodeURIComponent(num(no))}`);
  }

  // ------------------------------------------------------------ drops lives
  async function dropsLives(type, id, campaignNo, { size = 20 } = {}) {
    const params = new URLSearchParams({
      campaignNo: String(num(campaignNo)),
      size: String(num(size) || 20),
      sortType: "POPULAR",
    });
    const c = await send(
      `${API}/service/v1/categories/${encodeURIComponent(str(type))}/${encodeURIComponent(str(id))}/drops-lives?${params}`,
    );
    const data = c && Array.isArray(c.data) ? c.data : [];
    return data.filter((r) => r && typeof r === "object").map(liveRow);
  }

  // ------------------------------------------------------- live detail/status
  async function liveDetail(channelId) {
    const ch = str(channelId);
    const c =
      (await send(
        `${API}/service/v3/channels/${encodeURIComponent(ch)}/live-detail`,
        { referer: `${HOME}/live/${ch}` },
      )) || {};
    return {
      liveId: num(c.liveId),
      openAt: kst(c.openDate),
      status: str(c.status),
      dropsCampaignNo: num(c.dropsCampaignNo),
      channelName: str(
        c.channelName || (c.channel && c.channel.channelName) || "",
      ),
    };
  }

  // CHZZK's own field names (measured 2026-10-23): liveTokenList,
  // krOnlyViewing, abroadCountry. v1 read liveTokens/krOnly/abroad, which do
  // not exist, so every heartbeat went out with no tokens and was not
  // credited. The old names stay as a fallback only.
  async function liveStatus(channelId) {
    const ch = str(channelId);
    const c =
      (await send(
        `${API}/polling/v3.1/channels/${encodeURIComponent(ch)}/live-status`,
        { referer: `${HOME}/live/${ch}`, extra: POLLING },
      )) || {};
    const tokens = Array.isArray(c.liveTokenList) ? c.liveTokenList : Array.isArray(c.liveTokens) ? c.liveTokens : [];
    return {
      status: str(c.status),
      dropsCampaignNo: num(c.dropsCampaignNo),
      liveTokens: tokens,
      krOnly: !!(c.krOnlyViewing != null ? c.krOnlyViewing : c.krOnly),
      blindType: c.blindType == null ? null : str(c.blindType),
      adult: !!c.adult,
      abroad: !!(c.abroadCountry != null ? c.abroadCountry : c.abroad),
    };
  }

  // ---------------------------------------------------------- watch event
  // The one call the farm sends to credit watch time. `scene: "25"` is the
  // player's own scene id and CHZZK refuses the event without it. The body
  // shape here is byte-for-byte what the web player sends.
  async function watchEvent({
    channelId,
    liveId,
    type,
    sessionId,
    positionAt,
    awt,
    liveTokens,
  } = {}) {
    const ch = str(channelId);
    const body = {
      channelId: ch,
      liveId: num(liveId),
      payload: {
        watchEventType: str(type),
        sessionId: str(sessionId),
        duration: 30,
        positionAt: Number.isFinite(Number(positionAt)) ? Number(positionAt) : 0,
        // awt = seconds watched this session, a number (the player omits it at 0).
        ...(Number(awt) > 0 ? { awt: Math.round(Number(awt)) } : {}),
      },
      liveTokens: Array.isArray(liveTokens) ? liveTokens : [],
      autoPlay: false,
      radioMode: false,
    };
    await send(`${API}/polling/v1/watch-event/live`, {
      method: "POST",
      body,
      referer: `${HOME}/live/${ch}`,
      extra: { ...POLLING, scene: "25", "content-type": "application/json" },
    });
    return true;
  }

  // ---------------------------------------------------------------- rewards
  async function challenges() {
    requireLogin();
    const c = await send(`${API}/commercial/v2/drops/rewards/challenges`);
    return c && Array.isArray(c.challengeList) ? c.challengeList : [];
  }

  async function claims() {
    requireLogin();
    const c = await send(`${API}/commercial/v2/drops/rewards/claims`);
    return c && Array.isArray(c.claimList) ? c.claimList : [];
  }

  async function couponCode(rewardNo) {
    requireLogin();
    const c =
      (await send(
        `${API}/commercial/v1/drops/rewards/${encodeURIComponent(num(rewardNo))}/coupon-code`,
      )) || {};
    return { codeNo: str(c.codeNo), code: str(c.code) };
  }

  // ----------------------------------------------------------- egress check
  // Goes through the shared transport so the proxy applies (that is the whole
  // point of the check: know what country CHZZK will see). The CHZZK header
  // kit and the cookie are stripped — ipinfo must never see them.
  async function egressCountry() {
    try {
      const res = await transport.request(IPINFO, {
        method: "GET",
        headers: {
          "user-agent": UA,
          accept: "application/json",
          "accept-language": ACCEPT_LANG,
        },
      });
      if (res && res.status === 200 && res.json && res.json.country) {
        return str(res.json.country);
      }
      return "";
    } catch {
      return "";
    }
  }

  return {
    userStatus,
    categoriesLive,
    campaign,
    dropsLives,
    liveDetail,
    liveStatus,
    watchEvent,
    challenges,
    claims,
    couponCode,
    egressCountry,
  };
}

module.exports = { makeClient, API, GAME };
