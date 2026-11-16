"use strict";

const ORIGIN = "https://www.z2u.com";

class Z2uError extends Error {
  constructor(code, message, { uncertain = false } = {}) {
    super(message);
    this.name = "Z2uError";
    this.code = code;
    this.uncertain = uncertain;
  }
}

function checkedUrl(path) {
  const url = new URL(path, ORIGIN);
  if (url.origin !== ORIGIN || url.username || url.password || url.hash) {
    throw new Z2uError("INVALID_URL", "Z2U requests must use the fixed HTTPS origin");
  }
  return url;
}

function gateCode(url, html) {
  const path = new URL(url || ORIGIN, ORIGIN).pathname;
  if (/\/user\/verify_pass(?:\.html)?$/i.test(path) || /<h[1-6][^>]*>\s*Enter Privacy Password\s*</i.test(html)) return "PRIVACY_LOCKED";
  if (/\/userStorage\/applyCheck(?:\.html)?$/i.test(path)) return "STORAGE_DISABLED";
  if (/\/(?:login|user\/login)(?:\.html)?$/i.test(path) || /<form[^>]+(?:id|action)=["'][^"']*login/i.test(html)) return "SESSION_EXPIRED";
  if (/<title>\s*(?:Just a moment|Attention Required)|cf-chl-|challenge-platform/i.test(html)) return "CHALLENGE";
  return null;
}

async function boundedText(response, limit) {
  const tooLarge = () => new Z2uError("RESPONSE_TOO_LARGE", "Z2U response exceeded the configured size limit");
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) throw tooLarge();
  if (!response.body?.getReader) {
    // Also supports injected transports used by tests. Native fetch takes the
    // streaming path, which limits allocation before reading the whole body.
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > limit) throw tooLarge();
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) throw tooLarge();
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

/**
 * Session ownership stays with the caller. In a signed-in browser, fetch includes
 * its existing cookies. Node callers supply an authenticated fetch wrapper or
 * getHeaders/acceptResponse functions backed by their private session store.
 * Never pass the session or HTTP bodies to logs.
 */
function createZ2uClient({ fetch: fetchImpl = globalThis.fetch, getHeaders = () => ({}),
  acceptResponse = async () => {}, intervalMs = 4000, timeoutMs = 30000,
  maxResponseBytes = 8 * 1024 * 1024,
  signal,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is required");
  if (!Number.isFinite(intervalMs) || intervalMs < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("Invalid timing options");
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 128 * 1024 * 1024) throw new TypeError("Invalid response size limit");
  let tail = Promise.resolve();
  let lastStarted = -Infinity;

  function serialized(task) {
    const next = tail.then(task, task);
    tail = next.catch(() => {});
    return next;
  }

  async function wire(path, { method = "GET", body, mutation = false } = {}) {
    const url = checkedUrl(path);
    const checkAbort = () => { if (signal?.aborted) throw new Z2uError("ABORTED", "Z2U operation was aborted"); };
    checkAbort();
    const delay = intervalMs - (now() - lastStarted);
    if (delay > 0) await sleep(delay);
    checkAbort();
    // Header setup failures happen before dispatch and must not claim a write ran.
    let headers;
    try {
      headers = new Headers(await getHeaders(url.href));
      headers.set("X-Requested-With", "XMLHttpRequest");
      if (body instanceof URLSearchParams) headers.set("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
    } catch {
      throw new Z2uError("SESSION_SETUP_FAILED", "Z2U session headers could not be prepared");
    }
    checkAbort();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    lastStarted = now();
    let response, text;
    try {
      response = await fetchImpl(url.href, { method, headers, body, credentials: "include", redirect: "manual", signal: controller.signal });
      if (response.url && checkedUrl(response.url).origin !== ORIGIN) throw new Error("Unexpected origin");
      // Never follow redirects carrying supplied session headers to another host.
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        const location = response.headers.get("location");
        const code = location ? gateCode(checkedUrl(location).href, "") : null;
        throw new Z2uError(code || "REDIRECT", "Z2U redirected the request; inspect the signed-in session", { uncertain: mutation });
      }
      await acceptResponse(response, url.href);
      text = await boundedText(response, maxResponseBytes);
      const gate = gateCode(response.url || url.href, text);
      if (gate) throw new Z2uError(gate, "Z2U session access requires attention", { uncertain: mutation });
      if (!response.ok) throw new Z2uError("HTTP_ERROR", `Z2U returned HTTP ${response.status}`, { uncertain: mutation });
      return { text, headers: response.headers, url: response.url || url.href };
    } catch (error) {
      if (error instanceof Z2uError) {
        if (mutation) error.uncertain = true;
        throw error;
      }
      // Fetch exceptions may include sensitive URLs or response bodies; discard
      // their messages, and never automatically replay a dispatched mutation.
      throw new Z2uError(signal?.aborted ? "ABORTED" : mutation ? "WRITE_UNCERTAIN" : "READ_FAILED",
        mutation ? "Z2U write outcome is unknown; reconcile before retrying" : "Z2U read failed", { uncertain: mutation });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      // Node's fetch pool cannot rely on browser-style garbage collection to
      // release unread redirect/error bodies. Do not let cleanup mask verdicts.
      if (response?.body && !response.bodyUsed && !response.body.locked) {
        await response.body.cancel().catch(() => {});
      }
    }
  }

  function jsonResult(result, mutation) {
    let envelope;
    try { envelope = JSON.parse(result.text); } catch {
      throw new Z2uError(mutation ? "WRITE_UNCERTAIN" : "INVALID_RESPONSE", "Z2U did not return the expected JSON envelope", { uncertain: mutation });
    }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || Number(envelope.code) !== 1) {
      throw new Z2uError(mutation ? "WRITE_UNCERTAIN" : "REQUEST_REJECTED",
        mutation ? "Z2U did not acknowledge the write; reconcile before retrying" : "Z2U rejected the read", { uncertain: mutation });
    }
    return mutation ? { acknowledged: true, verified: false, data: envelope.data } : envelope.data;
  }

  return Object.freeze({
    readPage: path => serialized(async () => (await wire(path)).text),
    readJson: (path, fields = {}) => serialized(async () => jsonResult(await wire(path, { method: "POST", body: new URLSearchParams(fields) }), false)),
    // buildBody receives only a fresh CSRF token; body values never get logged.
    mutate: (path, buildBody, { csrf = false } = {}) => serialized(async () => {
      checkedUrl(path);
      let token;
      if (csrf) {
        token = (await wire("/public/createToken")).headers.get("__token__");
        if (!token) throw new Z2uError("TOKEN_MISSING", "Z2U did not provide a CSRF response header");
      }
      const body = buildBody(token);
      return jsonResult(await wire(path, { method: "POST", body, mutation: true }), true);
    }),
  });
}

module.exports = { ORIGIN, Z2uError, checkedUrl, gateCode, createZ2uClient };
