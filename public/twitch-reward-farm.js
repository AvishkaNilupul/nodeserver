(() => {
  const $ = (id) => document.getElementById(id);
  const visible = () => location.hash === "#farm";
  let busy = false;
  async function request(url, body) {
    const r = await fetch("/api/twitch-rewards" + url, { credentials: "same-origin",
      ...(body !== undefined ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const data = await r.json();
    if (!r.ok) throw Error(data.message || "Farm request failed.");
    return data;
  }
  function text(tag, value) { const e = document.createElement(tag); e.textContent = value; return e; }
  async function load() {
    if (!visible() || busy) return;
    try {
      const { bots, endsAt } = await request("/farm");
      $("reward-farm-summary").textContent = `${bots.length} dedicated account(s) · viewing ends ${new Date(endsAt).toLocaleString()}`;
      $("reward-farm-bots").replaceChildren(...bots.map(bot => {
        const card = document.createElement("article"); card.className = "card";
        card.append(text("h3", bot.viewer), text("p", `Bot: ${bot.state} · Target: ${bot.desired}`));
        card.append(text("p", bot.currentMinutes == null ? "Twitch watch progress: not reported" : `Twitch watch progress: ${bot.currentMinutes}/${bot.requiredMinutes} minutes`));
        card.append(text("p", bot.activity || "Waiting for the worker's first report."));
        if (bot.error) card.append(text("p", bot.error));
        card.append(text("small", bot.checkedAt ? `Last checked ${new Date(bot.checkedAt).toLocaleString()}` : "Not checked yet"));
        const controls = document.createElement("div"); controls.className = "row";
        for (const verb of ["start", "stop"]) {
          const button = text("button", verb === "start" ? "Start" : "Stop"); button.type = "button"; button.className = "btn";
          button.disabled = verb === "start" && bot.desired === "running" && bot.state !== "stopped";
          button.addEventListener("click", () => perform(() => request(`/farm/${bot._id}/${verb}`, {})));
          controls.append(button);
        }
        const account = text("a", "Accounts & codes"); account.href = "#accounts"; controls.append(account);
        card.append(controls); return card;
      }));
      if (!bots.length) $("reward-farm-bots").append(text("p", "No dedicated bots yet. Add one verified account from the pool."));
    } catch (e) { $("reward-farm-status").textContent = e.message; }
  }
  async function perform(fn) {
    if (busy) return;
    busy = true; $("reward-farm-add").disabled = true;
    $("reward-farm-status").textContent = "Applying…";
    try { await fn(); $("reward-farm-status").textContent = "Saved."; }
    catch (e) { $("reward-farm-status").textContent = e.message; }
    finally { busy = false; $("reward-farm-add").disabled = false; await load(); }
  }
  $("reward-farm-add").addEventListener("click", () => perform(() => request("/farm", {})));
  function show() {
    $("farm-view").hidden = !visible();
    $("tab-farm").classList.toggle("is-active", visible());
    if (visible()) { $("campaign-view").hidden = true; $("accounts-view").hidden = true; load(); }
  }
  addEventListener("hashchange", show);
  $("refresh").addEventListener("click", load);
  setInterval(() => { if (!document.hidden) load(); }, 20000);
  show();
})();
