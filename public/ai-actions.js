// Shared client-side executor for coworker actions. Runs in the operator's OWN
// authenticated browser, calling the SAME existing admin endpoints the manual
// UI uses — no server-side executor, no auth bypass. Used by both the Proposals
// inbox and inline "Approve & run" buttons in the AI chat.
(function () {
  async function j(method, path, body) {
    const r = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await r.json(); } catch (e) {}
    if (!r.ok || data.success === false) throw new Error(data.message || (method + " " + path + " (" + r.status + ")"));
    return data;
  }

  async function waitProvisioningFree(log) {
    for (let i = 0; i < 100; i++) {
      let s = {};
      try { s = await j("GET", "/api/webbot-farm/bots-status"); } catch (e) {}
      if (!s.provisioning) return;
      if (i === 0) log("  …waiting for the Pi to finish provisioning the previous bot", "");
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error("timed out waiting for provisioning to free up");
  }

  async function webbotSplit(action, log) {
    const botId = String(action.botId);
    const game = action.game;
    log("Reading web-farm state…");
    const state = await j("GET", "/api/webbot-farm/state");
    const bot = (state.bots || []).find((b) => String(b.id) === botId);
    if (!bot) throw new Error("bot " + botId + " not found (already released?)");
    const count = bot.count;
    let parts = action.parts && action.parts.length >= 2 ? action.parts.slice() : null;
    if (!parts) { const h = Math.floor(count / 2); parts = [h, count - h]; }
    log("Bot " + botId + ": " + count + " accounts, game \"" + game + "\" → splitting into " + parts.join(" + ") + ".");
    log("Releasing bot " + botId + "…");
    const rel = await j("POST", "/api/webbot-farm/bots/" + botId + "/release");
    log("  ✓ released " + (rel.released != null ? rel.released : "") + " accounts to idle", "ok");
    for (let i = 0; i < parts.length; i++) {
      await waitProvisioningFree(log);
      log("Creating bot " + (i + 1) + "/" + parts.length + ": " + game + " × " + parts[i] + "…");
      const c = await j("POST", "/api/webbot-farm/bots", { game, count: parts[i] });
      log("  ✓ " + (c.message || ("bot " + c.id + " created with " + c.accounts + " accounts")), "ok");
    }
    log("Done. Watch /webbot-farm.html for the two bots to finish provisioning on the Pi.", "ok");
  }

  // Re-pin: take the EXACT accounts currently in the given bot(s), release those
  // bots, and recreate them pinned to a new game using those same accounts (via
  // the create endpoint's explicit `logins`). Fixes "wrong accounts on wrong
  // game" without scattering them.
  async function webbotRepin(action, log) {
    const botIds = (action.botIds || []).map(String);
    const game = action.game;
    if (!botIds.length || !game) throw new Error("botIds and game required");
    log("Collecting the exact accounts from bot(s) " + botIds.join(", ") + "…");
    let logins = [];
    for (const bid of botIds) {
      const r = await j("GET", "/api/webbot-farm/bots/" + bid + "/accounts");
      const ls = (r.accounts || []).map((a) => a.login).filter(Boolean);
      log("  bot " + bid + ": " + ls.length + " accounts");
      logins = logins.concat(ls);
    }
    if (!logins.length) throw new Error("no accounts found on those bots");
    let parts = action.parts && action.parts.length ? action.parts.slice() : null;
    if (!parts) {
      const n = botIds.length || 2, per = Math.floor(logins.length / n);
      parts = Array(n).fill(per); parts[n - 1] += logins.length - per * n;
    }
    log("Total " + logins.length + " accounts → " + parts.length + " bot(s) of " + parts.join(" + ") + ", game \"" + game + "\".");
    for (const bid of botIds) {
      log("Releasing bot " + bid + "…");
      const rel = await j("POST", "/api/webbot-farm/bots/" + bid + "/release");
      log("  ✓ released " + (rel.released != null ? rel.released : "") + " to idle", "ok");
    }
    let idx = 0;
    for (let i = 0; i < parts.length; i++) {
      await waitProvisioningFree(log);
      const slice = logins.slice(idx, idx + parts[i]); idx += parts[i];
      log("Creating bot " + (i + 1) + "/" + parts.length + ": " + game + " × " + slice.length + " (exact accounts)…");
      const c = await j("POST", "/api/webbot-farm/bots", { game, count: slice.length, logins: slice });
      log("  ✓ " + (c.message || ("bot " + c.id + " created with " + c.accounts + " accounts")), "ok");
      if (c.accounts !== slice.length) log("  ⚠ asked for " + slice.length + " but got " + c.accounts + " (some weren't idle/valid)", "err");
    }
    log("Done. Those exact accounts are now pinned to " + game + ".", "ok");
  }

  window.AIActions = {
    // run(action, log) — log(msg, cls) where cls is "" | "ok" | "err"
    async run(action, log) {
      if (!action || !action.type) throw new Error("no action");
      if (action.type === "webbot_split") return webbotSplit(action, log);
      if (action.type === "webbot_repin") return webbotRepin(action, log);
      throw new Error("unknown action type: " + action.type);
    },
    label(action) {
      if (action && action.type === "webbot_split")
        return "Split bot " + action.botId + " (" + action.game + ")";
      if (action && action.type === "webbot_repin")
        return "Re-pin bot(s) " + (action.botIds || []).join(",") + " → " + action.game;
      return action && action.type ? action.type : "action";
    },
  };
})();
