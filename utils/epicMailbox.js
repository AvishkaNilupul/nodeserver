// Provider-agnostic mailbox facade for extension-driven Epic Games signups.
//
// Two providers wired in as of 2026-07-27:
//   • tempmailio  — https://api.internal.temp-mail.io/api/v3
//                    Fully free, anonymous REST, 7+ rotating random-string
//                    domains (bltiwd.com, ozsaip.com, ruutukf.com, …) with
//                    ~90-day per-domain lifetime. Preferred because Epic
//                    has been observed silently 4xx-ing mail.tm addresses.
//   • mailtm      — https://api.mail.tm  (fallback)
//                    Was primary. Currently exposes exactly one active
//                    shared domain (web-library.net), which is on multiple
//                    public disposable-email classifiers and is being
//                    rejected by Epic's /id/api/account validator.
//
// Strategy is picked via EPIC_MAILBOX_PROVIDER: "tempmailio" | "mailtm" |
// "auto" (default). Auto tries temp-mail.io first and falls back to
// mail.tm on allocate failure.
//
// Shape:
//   allocate() -> { address, provider, providerMeta }
//   waitForOtp(session, { timeoutMs, senderRegex, otpRegex, pollMs })
//     -> { code, receivedAt } | null
//   release(session) -> void  (best-effort, swallows errors)
const axios = require("axios");
const crypto = require("crypto");

const MAILTM_BASE = "https://api.mail.tm";
const TEMPMAILIO_BASE = "https://api.internal.temp-mail.io/api/v3";
const DEFAULT_SENDER = /@(accts|acct-auth|noreply|mail)\.epicgames\.com$/i;
const DEFAULT_OTP = /\b(\d{6})\b/;

function pickedProvider() {
  return (process.env.EPIC_MAILBOX_PROVIDER || "auto").toLowerCase();
}

// ---------- mail.tm ----------

let mailtmDomainCache = { at: 0, list: [] };
async function fetchMailtmDomains() {
  if (
    Date.now() - mailtmDomainCache.at < 5 * 60 * 1000 &&
    mailtmDomainCache.list.length
  ) {
    return mailtmDomainCache.list;
  }
  const r = await axios.get(MAILTM_BASE + "/domains", {
    timeout: 15000,
    headers: { Accept: "application/json" },
  });
  const body = r.data || {};
  const members = Array.isArray(body)
    ? body
    : body["hydra:member"] || body.member || [];
  const active = members
    .filter((d) => d.isActive !== false && !d.isPrivate)
    .map((d) => d.domain)
    .filter(Boolean);
  if (!active.length) {
    throw new Error("mail.tm returned no active domains");
  }
  mailtmDomainCache = { at: Date.now(), list: active };
  return active;
}

function randomLocalPart() {
  // 12-char lowercased alphanumeric, no dashes/dots — Epic canonicalizes
  // both away before dedupe, so keep the local part opaque.
  return crypto
    .randomBytes(9)
    .toString("base64")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);
}

function randomInboxPassword() {
  return crypto.randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/g, "");
}

async function allocateMailtm() {
  const domains = await fetchMailtmDomains();
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const domain = domains[crypto.randomInt(0, domains.length)];
    const address = randomLocalPart() + "@" + domain;
    const password = randomInboxPassword();
    try {
      const createRes = await axios.post(
        MAILTM_BASE + "/accounts",
        { address, password },
        {
          timeout: 15000,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        },
      );
      const accountId = createRes.data && createRes.data.id;
      const tokenRes = await axios.post(
        MAILTM_BASE + "/token",
        { address, password },
        {
          timeout: 15000,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        },
      );
      const token = tokenRes.data && tokenRes.data.token;
      if (!token) throw new Error("mail.tm returned no token");
      return {
        address,
        provider: "mailtm",
        providerMeta: {
          mailtmAccountId: accountId || "",
          mailtmToken: token,
          mailtmPassword: password,
          domain,
          createdAt: new Date().toISOString(),
        },
      };
    } catch (err) {
      lastErr = err;
      const status =
        err && err.response && err.response.status
          ? err.response.status
          : "network";
      if (status === 422 || status === 429 || status === 502 || status === 503) {
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    "mail.tm allocate failed after 3 attempts" +
      (lastErr ? ": " + lastErr.message : ""),
  );
}

async function listMessagesMailtm(token) {
  const r = await axios.get(MAILTM_BASE + "/messages", {
    timeout: 15000,
    headers: {
      Accept: "application/json",
      Authorization: "Bearer " + token,
    },
  });
  const body = r.data || {};
  return Array.isArray(body)
    ? body
    : body["hydra:member"] || body.member || [];
}

async function fetchMessageMailtm(token, id) {
  const r = await axios.get(MAILTM_BASE + "/messages/" + id, {
    timeout: 15000,
    headers: {
      Accept: "application/json",
      Authorization: "Bearer " + token,
    },
  });
  return r.data || {};
}

async function waitForOtpMailtm({
  providerMeta,
  timeoutMs = 90000,
  senderRegex = DEFAULT_SENDER,
  otpRegex = DEFAULT_OTP,
  pollMs = 3000,
} = {}) {
  const token = providerMeta && providerMeta.mailtmToken;
  if (!token) throw new Error("waitForOtp: providerMeta.mailtmToken missing");
  const deadline = Date.now() + timeoutMs;
  const seenIds = new Set();
  while (Date.now() < deadline) {
    try {
      const messages = await listMessagesMailtm(token);
      for (const m of messages) {
        if (seenIds.has(m.id)) continue;
        seenIds.add(m.id);
        const from =
          (m.from && (m.from.address || m.from.value || "")) || "";
        if (!senderRegex.test(from)) continue;
        const intro = String(m.intro || "");
        let match = intro.match(otpRegex);
        if (!match) {
          try {
            const full = await fetchMessageMailtm(token, m.id);
            const text = String(full.text || full.subject || "");
            match = text.match(otpRegex);
          } catch {
            /* retry next tick */
          }
        }
        if (match) {
          return {
            code: match[1] || match[0],
            receivedAt: new Date().toISOString(),
          };
        }
      }
    } catch {
      /* ignore poll errors */
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

async function releaseMailtm({ providerMeta } = {}) {
  const token = providerMeta && providerMeta.mailtmToken;
  const id = providerMeta && providerMeta.mailtmAccountId;
  if (!token || !id) return;
  try {
    await axios.delete(MAILTM_BASE + "/accounts/" + id, {
      timeout: 10000,
      headers: { Authorization: "Bearer " + token },
    });
  } catch {
    /* best-effort cleanup */
  }
}

// ---------- temp-mail.io ----------

let tempmailioDomainCache = { at: 0, list: [] };
async function fetchTempmailioDomains() {
  if (
    Date.now() - tempmailioDomainCache.at < 5 * 60 * 1000 &&
    tempmailioDomainCache.list.length
  ) {
    return tempmailioDomainCache.list;
  }
  const r = await axios.get(TEMPMAILIO_BASE + "/domains", {
    timeout: 15000,
    headers: { Accept: "application/json" },
  });
  const body = r.data || {};
  const domains = Array.isArray(body.domains) ? body.domains : [];
  const active = domains
    .filter((d) => d && d.type === "public" && d.name)
    .map((d) => d.name);
  if (!active.length) {
    throw new Error("temp-mail.io returned no active public domains");
  }
  tempmailioDomainCache = { at: Date.now(), list: active };
  return active;
}

async function allocateTempmailio() {
  // Deliberately pin the domain so we can rotate away from any we've
  // seen fail. Random-pick per attempt from the cached pool.
  const domains = await fetchTempmailioDomains();
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const domain = domains[crypto.randomInt(0, domains.length)];
    const name = randomLocalPart();
    try {
      const r = await axios.post(
        TEMPMAILIO_BASE + "/email/new",
        { name, domain },
        {
          timeout: 15000,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        },
      );
      const body = r.data || {};
      const address = body.email || name + "@" + domain;
      const token = body.token || "";
      if (!token) throw new Error("temp-mail.io returned no token");
      return {
        address,
        provider: "tempmailio",
        providerMeta: {
          tempmailioToken: token,
          domain,
          createdAt: new Date().toISOString(),
        },
      };
    } catch (err) {
      lastErr = err;
      const status =
        err && err.response && err.response.status
          ? err.response.status
          : "network";
      if (status === 400 || status === 409 || status === 429 || status >= 500) {
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    "temp-mail.io allocate failed after 3 attempts" +
      (lastErr ? ": " + lastErr.message : ""),
  );
}

async function waitForOtpTempmailio({
  providerMeta,
  address,
  timeoutMs = 90000,
  senderRegex = DEFAULT_SENDER,
  otpRegex = DEFAULT_OTP,
  pollMs = 3000,
} = {}) {
  if (!address) throw new Error("waitForOtp: address missing");
  const deadline = Date.now() + timeoutMs;
  const seenIds = new Set();
  while (Date.now() < deadline) {
    try {
      const r = await axios.get(
        TEMPMAILIO_BASE + "/email/" + encodeURIComponent(address) + "/messages",
        {
          timeout: 15000,
          headers: { Accept: "application/json" },
        },
      );
      const messages = Array.isArray(r.data) ? r.data : [];
      for (const m of messages) {
        if (seenIds.has(m.id)) continue;
        seenIds.add(m.id);
        const from = String(m.from || "");
        if (!senderRegex.test(from)) continue;
        const haystack =
          String(m.body_text || "") +
          " " +
          String(m.body_html || "") +
          " " +
          String(m.subject || "");
        const match = haystack.match(otpRegex);
        if (match) {
          return {
            code: match[1] || match[0],
            receivedAt: new Date().toISOString(),
          };
        }
      }
    } catch {
      /* ignore poll errors */
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

async function releaseTempmailio({ providerMeta, address } = {}) {
  const token = providerMeta && providerMeta.tempmailioToken;
  if (!token || !address) return;
  try {
    await axios.delete(
      TEMPMAILIO_BASE +
        "/email/" +
        encodeURIComponent(address) +
        "?token=" +
        encodeURIComponent(token),
      { timeout: 10000 },
    );
  } catch {
    /* best-effort cleanup */
  }
}

// ---------- Public facade ----------

async function allocate() {
  const strategy = pickedProvider();
  if (strategy === "mailtm") return allocateMailtm();
  if (strategy === "tempmailio") return allocateTempmailio();
  // auto: try temp-mail.io first (larger, fresher domain pool) then fall
  // back to mail.tm.
  try {
    return await allocateTempmailio();
  } catch (err) {
    console.warn(
      "[epicMailbox] temp-mail.io allocate failed, falling back to mail.tm:",
      err.message,
    );
    return allocateMailtm();
  }
}

async function waitForOtp(session, opts = {}) {
  const provider = session && session.provider;
  const providerMeta = session && session.providerMeta;
  const address = session && (session.address || (session.email));
  if (provider === "tempmailio") {
    return waitForOtpTempmailio({ providerMeta, address, ...opts });
  }
  if (!provider || provider === "mailtm") {
    return waitForOtpMailtm({ providerMeta, ...opts });
  }
  throw new Error("Unknown mailbox provider: " + provider);
}

async function release(session) {
  const provider = session && session.provider;
  const providerMeta = session && session.providerMeta;
  const address = session && (session.address || session.email);
  if (provider === "tempmailio") {
    return releaseTempmailio({ providerMeta, address });
  }
  if (!provider || provider === "mailtm") {
    return releaseMailtm({ providerMeta });
  }
}

module.exports = {
  allocate,
  waitForOtp,
  release,
  _internal: {
    fetchDomains: fetchMailtmDomains, // kept for back-compat with any tests
    fetchMailtmDomains,
    allocateMailtm,
    waitForOtpMailtm,
    releaseMailtm,
    fetchTempmailioDomains,
    allocateTempmailio,
    waitForOtpTempmailio,
    releaseTempmailio,
  },
};
