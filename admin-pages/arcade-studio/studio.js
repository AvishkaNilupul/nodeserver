"use strict";

const base = "/admin/arcade-studio/";
const byId = id => document.getElementById(id);
const durations = [60, 300, 1800, 3600, 7200, 10800, 14400, 18000];
const durationFor = { live: 18000, test: 300 };
const artwork = [
  ["Marble Circuit", "marble", "Pick the race winner.", "!pick"],
  ["Word Vault", "word", "Unscramble the tiles.", "!solve"],
  ["Echo Grid", "echo", "Repeat the pad sequence.", "!echo"],
  ["Vector Run", "route", "Trace the arrows to a cell.", "!route"],
  ["Orbit Census", "orbit", "Count the ringed moons.", "!count"],
  ["Number Forge", "forge", "Pick the missing operator.", "!forge"],
];
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
const selected = new Set();
const controls = new Map();
let channels = new Map();
let monitor = "";
let busy = false;
let online = false;
let ready = false;
let timer;
let pollVersion = 0;
let frameRequest;
let frameTimer;
let frameIdentity = "";
let setupChannel = "";
let stopArm = null;

function el(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function nameOf(slug) {
  return channels.get(slug)?.displayName || (slug === "wiznims" ? "WizNims" : slug);
}
function active(channel) {
  return !!channel && ["live", "starting", "stopping", "external"].includes(channel.state);
}
function alreadyRunning(channel) {
  return !!channel?.can_stop && ["starting", "live"].includes(channel.state) && channel.mode === byId("mode").value;
}
function startable(channel) {
  return !!channel?.csrf && channel.key_ready === true && !channel.can_stop && ["idle", "error"].includes(channel.state);
}
function badge(channel) {
  if (!channel || !online) return "Unavailable";
  if (channel.state === "idle") return channel.key_ready === false ? "Setup needed" : "Ready";
  return ({ live: channel.mode === "test" ? "Private test" : "Live", starting: "Starting", stopping: "Ending",
    occupied: "Channel in use", external: "External encoder", transfer: "Waiting for transfer", error: "Encoder error" })[channel.state] || "Unavailable";
}
function selectedRows() {
  return [...selected].map(slug => channels.get(slug)).filter(Boolean);
}
function feedback(text = "", error = false) {
  byId("feedback").textContent = text;
  byId("feedback").hidden = !text;
  byId("feedback").classList.toggle("error", error);
}
function clearCodes() {
  for (const entry of controls.values()) entry.pin.value = "";
}
function resetStop() {
  stopArm = null;
  byId("stop").textContent = "End broadcast";
}
function addChannel(slug) {
  const label = el("label", undefined, "target");
  const check = el("input");
  check.type = "checkbox";
  check.value = slug;
  const title = el("span", nameOf(slug), "target-name");
  const state = el("span", "Checking…", "target-status");
  label.append(check, title, state);
  byId("targets").append(label);

  const pinRow = el("div", undefined, "confirm-row");
  const pinLabel = el("label", nameOf(slug) + " confirmation code");
  const pin = el("input");
  pin.id = "confirm-" + slug;
  pinLabel.htmlFor = pin.id;
  pin.type = "password";
  pin.inputMode = "numeric";
  pin.autocomplete = "off";
  pin.spellcheck = false;
  pin.pattern = "[0-9]{3}";
  pin.maxLength = 3;
  pin.placeholder = "3 digits";
  pinRow.append(pinLabel, pin);
  pinRow.hidden = true;
  byId("confirmations").append(pinRow);

  const tab = el("button", nameOf(slug));
  tab.type = "button";
  byId("monitors").append(tab);
  tab.addEventListener("click", () => setMonitor(slug));
  check.addEventListener("change", () => {
    if (check.checked) selected.add(slug); else selected.delete(slug);
    clearCodes();
    feedback();
    if (selected.size === 1) setMonitor([...selected][0]);
    render();
  });
  pin.addEventListener("input", renderSelection);
  controls.set(slug, { check, state, tab, pin, pinRow });
}
function setMonitor(slug) {
  if (slug !== monitor) {
    resetStop();
    clearFrame();
    monitor = slug;
  }
  render();
}
function liveTelemetry(channel) {
  const telemetry = channel?.telemetry;
  return online && active(channel) && Number.isFinite(telemetry?.updated_at) &&
    Math.abs(Date.now() / 1000 - telemetry.updated_at) < 20 ? telemetry : null;
}
function clearFrame() {
  clearTimeout(frameTimer);
  frameTimer = null;
  frameIdentity = "";
  if (frameRequest) {
    frameRequest.onload = frameRequest.onerror = null;
    frameRequest.removeAttribute("src");
    frameRequest = null;
  }
  byId("frame").hidden = true;
  byId("frame").removeAttribute("src");
}
function renderFrame(telemetry) {
  const id = telemetry && monitor + ":" + (telemetry.session || telemetry.started_at);
  if (id !== frameIdentity) clearFrame();
  if (!id || document.hidden || frameRequest || frameTimer) return;
  frameIdentity = id;
  const request = new Image();
  frameRequest = request;
  const done = ok => {
    if (frameIdentity !== id || request !== frameRequest) return;
    frameRequest = null;
    request.onload = request.onerror = null;
    const old = byId("frame");
    if (ok) {
      request.alt = nameOf(monitor) + " encoder preview";
      request.id = "frame";
      old.replaceWith(request);
    } else old.hidden = true;
    const quick = telemetry.game === "Echo Grid" && telemetry.phase === "Watch the pattern";
    frameTimer = setTimeout(() => { frameTimer = null; renderFrame(liveTelemetry(channels.get(monitor))); }, quick ? 350 : 2000);
  };
  request.onload = () => done(true);
  request.onerror = () => done(false);
  request.src = base + monitor + "/api/frame?t=" + Date.now();
}
function buildGames() {
  byId("games").replaceChildren(...artwork.map(([name, file, detail, command]) => {
    const card = el("article", undefined, "game");
    const image = el("img");
    image.src = base + monitor + "/images/" + file + ".webp";
    image.alt = "";
    const body = el("div");
    body.append(el("h3", name), el("p", detail), el("code", command), el("small"));
    card.append(image, body);
    return card;
  }));
}
function time(value) {
  return Number.isFinite(value) ? timeFormat.format(new Date(value * 1000)) : "";
}
function drawList(id, rows, empty) {
  const target = byId(id);
  target.replaceChildren(...(rows.length ? rows : [el("li", empty, "empty")]));
}
function renderMonitor() {
  const ch = channels.get(monitor);
  const t = liveTelemetry(ch);
  const s = active(ch);
  const label = nameOf(monitor);
  byId("monitor-name").textContent = label || "Channel";
  byId("monitor-state").textContent = badge(ch);
  byId("monitor-state").classList.toggle("live", online && ch?.state === "live");
  const main = byId("screen-note");
  main.textContent = !online ? "Reconnecting…" : s ? "Waiting for the next frame…" : "Standby";
  const watch = byId("watch");
  watch.hidden = !monitor;
  watch.href = "https://www.twitch.tv/" + monitor;
  const stop = byId("stop");
  stop.hidden = !online || !ch?.can_stop || ch.state === "stopping";
  stop.disabled = busy;
  if (stopArm?.slug !== monitor || stopArm?.started !== ch?.started_at || stop.hidden) resetStop();
  if (!stopArm) stop.textContent = ch?.mode === "test" ? "End private test" : "End broadcast";
  const banner = byId("standby");
  if (monitor) {
    const path = base + monitor + "/images/standby.webp";
    if (banner.getAttribute("src") !== path) banner.src = path;
    banner.hidden = false;
  }
  const publicListing = ch?.twitch?.is_live;
  const duration = Number.isFinite(ch?.started_at) && Number.isFinite(ch?.duration)
    ? "Ends at " + time(ch.started_at + ch.duration) : "";
  const info = [];
  if (s && online) { if (publicListing === true) info.push("Twitch live"); if (duration) info.push(duration); }
  else if (online && ch) info.push(ch.state === "idle" ? "No active broadcast" : ch.message || badge(ch));
  byId("session-detail").textContent = info.join(" · ");
  const format = [30, 60].includes(ch?.fps) ? "720p" + ch.fps : "720p";
  byId("format").textContent = format;
  byId("round").textContent = t ? [t.round ? "Round " + t.round : "", t.game, t.phase].filter(Boolean).join(" · ") : "Encoder preview";
  renderFrame(t);
  if (!byId("games").firstChild && monitor) buildGames();
  [...byId("games").children].forEach((card, index) => {
    const name = artwork[index][0];
    card.classList.toggle("active", t?.game === name);
    card.querySelector("small").textContent = t?.game === name ? "Now playing" : t?.next_game === name ? "Up next" : "";
  });
  const previous = online && !s ? ch?.last_public : null;
  const metrics = t || previous;
  byId("activity-heading").textContent = label ? label + " activity" : "Channel activity";
  byId("metrics-session").textContent = previous ? "Last public show · " + time(previous.ended_at) : "";
  const stats = [[previous ? "Players" : "Chat connection", previous?.players ?? t?.chat],
    ["Game commands", metrics?.commands], ["Accepted entries", metrics?.total_entries],
    [previous ? "Rounds played" : "This round", previous?.round ?? t?.entries]];
  byId("metrics").replaceChildren(...stats.map(([key, val]) => {
    const cell = el("div");
    cell.append(el("small", key), el("strong", val ?? "—"));
    return cell;
  }));
  const extra = [["duplicates", "repeat guesses"], ["late", "late guesses"], ["invalid", "invalid commands"],
    ["lookups", "score lookups"], ["dropped", "dropped"]].filter(([key]) => metrics?.[key] > 0);
  byId("exceptions").hidden = !extra.length;
  byId("exceptions").textContent = extra.map(([key, text]) => metrics[key] + " " + text).join(" · ");
  drawList("events", (online ? ch?.events || [] : []).slice(0, 25).map(event => {
    const row = el("li");
    row.append(el("time", time(event.at)), el("span", event.text));
    return row;
  }), "No recent broadcast events.");
  drawList("scores", (online ? ch?.leaderboard || [] : []).slice(0, 10).map((entry, n) =>
    el("li", (n + 1) + ". " + entry.name + " · " + entry.points + " pts")), "No scored players yet.");
}
function automaticFrameRate() {
  const friend = channels.get("wiznims");
  return selected.has("wiznims") && !alreadyRunning(friend) ? 30 : 60;
}
function requestedFrameRate() {
  return byId("fps").value === "auto" ? automaticFrameRate() : Number(byId("fps").value);
}
function renderSelection() {
  const mode = byId("mode").value;
  byId("auto-fps").textContent = "Automatic · " + automaticFrameRate() + " fps";
  const picked = selectedRows();
  const needed = picked.filter(ch => !alreadyRunning(ch));
  const blocked = needed.filter(ch => !startable(ch));
  let validCodes = true;
  for (const [slug, entry] of controls) {
    const channel = channels.get(slug);
    entry.check.checked = selected.has(slug);
    entry.check.disabled = !online || busy;
    entry.state.textContent = badge(channel);
    entry.tab.setAttribute("aria-pressed", String(monitor === slug));
    const needsPin = online && selected.has(slug) && startable(channel);
    if (!needsPin) entry.pin.value = "";
    entry.pinRow.hidden = !needsPin;
    entry.pin.required = needsPin;
    entry.pin.disabled = !needsPin || busy;
    if (needsPin && !/^[0-9]{3}$/.test(entry.pin.value)) validCodes = false;
  }
  byId("controls").disabled = busy || !online;
  let note;
  if (!online) note = "Waiting for Studio to connect.";
  else if (!picked.length) note = "Choose a channel to start.";
  else if (blocked.length) note = blocked.map(ch => nameOf(ch.channel) + " · " +
    (active(ch) && ch.mode && ch.mode !== mode ? "Already running in a different mode." : badge(ch))).join("  ");
  else if (!needed.length) note = "The selected " + (picked.length === 1 ? "channel is" : "channels are") + " already running.";
  else if (needed.length < picked.length) note = picked.filter(alreadyRunning).map(ch => nameOf(ch.channel)).join(", ") + " will keep its current show.";
  else note = mode === "test" ? "Enter a code for each private Twitch Inspector test." : "Enter a confirmation code for each channel you start.";
  byId("selection-note").textContent = note;
  const names = needed.map(ch => nameOf(ch.channel));
  byId("start").textContent = busy ? "Working…" : (mode === "live" ? "Go live" : "Start private test") +
    (names.length === 1 ? " on " + names[0] : names.length > 1 ? " on both channels" : "");
  byId("start").disabled = busy || !online || !needed.length || !!blocked.length || !validCodes;

  const setup = picked.find(ch => ch.channel === "wiznims" && ch.csrf && ch.key_ready === false && !active(ch));
  const nextSetup = online && setup ? setup.channel : "";
  if (setupChannel !== nextSetup) {
    byId("stream-key").value = "";
    byId("key-setup").open = false;
  }
  setupChannel = nextSetup;
  byId("key-setup").hidden = !nextSetup;
  byId("save-key").disabled = busy;
  byId("stream-key").disabled = busy;
  if (setup) {
    byId("key-summary").textContent = "Connect " + nameOf(setup.channel);
    byId("dashboard").href = "https://dashboard.twitch.tv/u/" + setup.channel + "/settings/stream";
  }
}
function render() {
  byId("connection").textContent = online ? "Studio connected" : "Connecting…";
  byId("connection").classList.toggle("online", online);
  renderSelection();
  renderMonitor();
}
function receive(data) {
  if (!Array.isArray(data?.channels) || !data.channels.length) throw new Error("Studio returned an empty channel list.");
  const next = new Map();
  for (const ch of data.channels) {
    if (!ch || !/^[a-z0-9_]{1,25}$/.test(ch.channel) || next.has(ch.channel)) throw new Error("Invalid channel list.");
    next.set(ch.channel, ch);
  }
  channels = next;
  for (const channel of next.keys()) if (!controls.has(channel)) addChannel(channel);
  if (!ready) {
    const path = location.pathname.slice(base.length).split("/")[0];
    monitor = channels.has(path) ? path : channels.keys().next().value;
    selected.add(monitor);
    ready = true;
  }
  online = true;
}
async function poll() {
  clearTimeout(timer);
  const ticket = ++pollVersion;
  try {
    const resp = await fetch(base + "api/channels", { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error("Unavailable");
    const data = await resp.json();
    if (ticket === pollVersion) receive(data);
  } catch {
    if (ticket === pollVersion) online = false;
  } finally {
    if (ticket === pollVersion) {
      render();
      timer = setTimeout(poll, document.hidden ? 8000 : 2400);
    }
  }
}
async function mutate(path, body, csrf, success) {
  if (busy) return;
  busy = true;
  ++pollVersion;
  clearTimeout(timer);
  clearCodes();
  feedback();
  render();
  const headers = { "Content-Type": "application/json" };
  if (csrf) headers["X-Studio-Token"] = csrf;
  try {
    const resp = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body),
      cache: "no-store", signal: AbortSignal.timeout(18000) });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Studio could not complete this action.");
    success(data);
  } catch (error) {
    feedback(error.name === "TimeoutError" ? "Request timed out. Checking channel status." : error.message, true);
  } finally {
    await poll();
    busy = false;
    render();
  }
}
byId("start-form").addEventListener("submit", event => {
  event.preventDefault();
  if (byId("start").disabled || busy || !online) return;
  const mode = byId("mode").value;
  const rows = selectedRows().map(ch => {
    const row = { channel: ch.channel, csrf: ch.csrf };
    if (!alreadyRunning(ch)) row.confirmationCode = controls.get(ch.channel).pin.value;
    return row;
  });
  mutate("api/start-selected", { channels: rows, mode, duration: Number(byId("duration").value),
    fps: requestedFrameRate(), volume: Number(byId("volume").value) }, null, data => {
    if (!Array.isArray(data.results)) throw new Error("Checking the latest channel status.");
    const text = { started: "Start accepted", already_running: "Already running", failed: "Start failed", unconfirmed: "Start unconfirmed" };
    feedback(data.results.map(row => nameOf(row.channel) + " · " + (text[row.outcome] || "Unknown result") +
      (row.message ? " — " + row.message : "")).join("\n"), data.results.some(row => !["started", "already_running"].includes(row.outcome)));
  });
});
byId("stop").addEventListener("click", () => {
  const ch = channels.get(monitor);
  if (!online || busy || !ch?.can_stop || ch.state === "stopping") return;
  if (stopArm?.slug !== monitor || stopArm?.started !== ch.started_at) {
    stopArm = { slug: monitor, started: ch.started_at };
    byId("stop").textContent = "Confirm end · " + nameOf(monitor);
    return;
  }
  const name = nameOf(monitor);
  resetStop();
  mutate(monitor + "/api/stop", {}, ch.csrf, () => feedback("Ending the show on " + name + "."));
});
byId("key-form").addEventListener("submit", event => {
  event.preventDefault();
  const ch = channels.get(setupChannel);
  if (!online || busy || !ch?.csrf || ch.key_ready !== false || !setupChannel || !byId("stream-key").value.trim()) return;
  const key = byId("stream-key").value.trim();
  byId("stream-key").value = "";
  mutate(setupChannel + "/api/provision", { streamKey: key }, ch.csrf, () => feedback(nameOf(ch.channel) + " is connected."));
});
function saveSettings() {
  try {
    localStorage.setItem("arcade-studio-settings", JSON.stringify({ mode: byId("mode").value,
      fps: byId("fps").value === "auto" ? null : Number(byId("fps").value),
      volume: Number(byId("volume").value), duration: durationFor }));
  } catch { /* Browser storage is optional. */ }
}
function readSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("arcade-studio-settings"));
    if (!saved) return;
    if (["live", "test"].includes(saved.mode)) byId("mode").value = saved.mode;
    if ([30, 60].includes(saved.fps)) byId("fps").value = String(saved.fps);
    if (Number.isInteger(saved.volume) && saved.volume >= 0 && saved.volume <= 100) byId("volume").value = String(saved.volume);
    for (const mode of ["live", "test"]) if (durations.includes(saved.duration?.[mode])) durationFor[mode] = saved.duration[mode];
  } catch { /* Default settings are usable without stored preferences. */ }
}
for (const id of ["mode", "duration", "fps", "volume"]) {
  byId(id).addEventListener(id === "volume" ? "input" : "change", () => {
    if (id === "mode") byId("duration").value = String(durationFor[byId("mode").value]);
    if (id === "duration") durationFor[byId("mode").value] = Number(byId("duration").value);
    byId("volume-label").textContent = byId("volume").value + "%";
    clearCodes();
    feedback();
    saveSettings();
    renderSelection();
  });
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { clearCodes(); clearFrame(); byId("stream-key").value = ""; resetStop(); renderSelection(); }
  else if (!busy) poll();
});
readSettings();
byId("duration").value = String(durationFor[byId("mode").value]);
byId("volume-label").textContent = byId("volume").value + "%";
poll();
