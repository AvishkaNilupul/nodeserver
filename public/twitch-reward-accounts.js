(() => {
  "use strict";
  const el = (id) => document.getElementById(id);
  const base = "/api/twitch-rewards";
  const inAccounts = () => location.hash === "#accounts";
  const time = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const date = (value) => time.format(new Date(value));
  const number = (value) => value.toLocaleString();
  let page = 1,
    pageCount = 1,
    listRequest = 0,
    detailRequest = 0;
  let selected = "",
    rows = [],
    choices = [],
    giveaway,
    chatCampaignId;
  let searchDelay;

  function node(tag, value, css) {
    const result = document.createElement(tag);
    if (value !== undefined) result.textContent = value;
    if (css) result.className = css;
    return result;
  }
  function button(label, action, css = "btn btn-sm") {
    const control = node("button", label, css);
    control.type = "button";
    control.addEventListener("click", () => action(control));
    return control;
  }
  const viewerPath = (name) => "/viewers/" + encodeURIComponent(name);
  async function api(path, method = "GET", body) {
    const response = await fetch(base + path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401 || response.status === 403) {
      clearDetail();
      throw new Error(
        "Sign in with your superadmin account to view accounts and codes.",
      );
    }
    const data = await response.json();
    if (!response.ok)
      throw new Error(
        data.message || "The request failed. Refresh and try again.",
      );
    return data;
  }

  function clearReveals() {
    document.querySelectorAll(".code-output").forEach((output) => {
      output.textContent = "";
    });
    document.querySelectorAll(".reveal-code").forEach((control) => {
      control.textContent = "Reveal code";
    });
  }
  function clearDetail() {
    selected = "";
    detailRequest++;
    choices = [];
    el("account-detail").hidden = true;
    el("account-items").replaceChildren();
    el("save-account-code").reset();
    el("save-code-panel").open = false;
  }
  function drawRows() {
    const body = el("account-rows");
    body.replaceChildren();
    for (const row of rows) {
      const tr = node("tr");
      tr.classList.toggle("is-selected", row.viewer === selected);
      const name = node("td");
      name.append(
        button(row.viewer, () => openAccount(row.viewer, true), "viewer-link"),
      );
      tr.append(
        name,
        node("td", number(row.rewards)),
        node("td", number(row.codes)),
        node("td", date(row.lastSeen)),
      );
      body.append(tr);
    }
  }
  async function loadList() {
    const ticket = ++listRequest;
    const query = el("account-search").value.trim();
    const params = new URLSearchParams({
      q: query,
      filter: el("account-filter").value,
      page: String(page),
    });
    el("account-status").textContent = "Loading accounts…";
    try {
      const data = await api("/accounts?" + params);
      if (ticket !== listRequest || !inAccounts()) return;
      pageCount = Math.max(1, Math.ceil(data.matched / data.pageSize));
      if (page > pageCount) {
        page = pageCount;
        return loadList();
      }
      giveaway = data.giveaway;
      chatCampaignId = data.chatCampaignId;
      rows = data.rows;
      for (const key of ["tracked", "farmed", "rewards", "codes"])
        el("stat-" + key).textContent = number(data.totals[key]);
      el("stat-redemptions").textContent =
        number(data.totals.redeemed) + " redeemed";
      drawRows();
      el("account-pager").hidden = data.matched <= data.pageSize;
      el("accounts-prev").disabled = page === 1;
      el("accounts-next").disabled = page === pageCount;
      el("account-range").textContent =
        "Page " +
        page +
        " of " +
        pageCount +
        " · " +
        number(data.matched) +
        " accounts";
      el("account-status").textContent = rows.length
        ? ""
        : data.totals.tracked
          ? "No accounts match this search."
          : "No tracked accounts yet. Enter a Twitch username to start.";
    } catch (err) {
      if (ticket !== listRequest || !inAccounts()) return;
      rows = [];
      drawRows();
      for (const key of ["tracked", "farmed", "rewards", "codes"])
        el("stat-" + key).textContent = "—";
      el("stat-redemptions").textContent = "";
      el("account-pager").hidden = true;
      el("account-status").textContent = err.message;
    }
  }

  function sameAward(a, b) {
    return a.campaignId === b.campaignId && a.reward === b.reward;
  }
  function campaignName(item) {
    if (item.campaignName) return item.campaignName;
    if (item.campaignId === chatCampaignId) return "GTAVI Launch Celebration";
    if (giveaway && sameAward(item, giveaway)) return giveaway.campaignName;
    return item.campaignId;
  }

  function codeActions(item, login, ticket) {
    const group = node("div");
    const info = [
      item.platform,
      item.region,
      "Saved " + date(item.codeSavedAt),
      item.codeRedeemedAt
        ? "Redeemed " + date(item.codeRedeemedAt)
        : "Unredeemed",
    ].filter(Boolean);
    group.append(node("p", info.join(" · "), "muted"));
    const actions = node("div", undefined, "row");
    const output = node("code", "", "code-output");
    const key = {
      campaignId: item.campaignId,
      reward: item.reward,
      version: item.codeVersion,
    };
    const path = viewerPath(login) + "/code";
    async function change(control, method, body) {
      control.disabled = true;
      try {
        await api(path, method, body);
        if (ticket !== detailRequest || !inAccounts()) return;
        await Promise.all([loadList(), openAccount(login)]);
      } catch (err) {
        if (ticket === detailRequest)
          el("account-detail-status").textContent = err.message;
      } finally {
        control.disabled = false;
      }
    }
    const reveal = button(
      "Reveal code",
      async (control) => {
        if (output.textContent) {
          clearReveals();
          return;
        }
        const selection = ++revealSequence;
        clearReveals();
        control.disabled = true;
        try {
          const result = await api(path + "/reveal", "POST", key);
          if (
            ticket !== detailRequest ||
            selection !== revealSequence ||
            !inAccounts() ||
            document.hidden
          )
            return;
          output.textContent = result.code;
          control.textContent = "Hide code";
        } catch (err) {
          if (ticket === detailRequest)
            el("account-detail-status").textContent = err.message;
        } finally {
          control.disabled = false;
        }
      },
      "btn btn-sm reveal-code",
    );
    actions.append(
      reveal,
      button(
        item.codeRedeemedAt ? "Mark unredeemed" : "Mark redeemed",
        (control) =>
          change(control, "PATCH", { ...key, redeemed: !item.codeRedeemedAt }),
      ),
      button("Remove saved code", (control) => {
        if (
          window.confirm(
            "Remove the stored code for " +
              login +
              " and keep the reward confirmation?",
          )
        )
          change(control, "DELETE", key);
      }),
    );
    group.append(actions, output);
    return group;
  }
  let revealSequence = 0;
  async function openAccount(login, focus = false) {
    const ticket = ++detailRequest;
    selected = login;
    clearReveals();
    choices = [];
    el("account-detail").hidden = false;
    el("detail-name").textContent = login;
    el("account-items").replaceChildren();
    el("save-account-code").reset();
    el("save-code-panel").open = false;
    el("save-code-panel").hidden = true;
    el("untrack-account").hidden = true;
    el("account-detail-status").textContent = "Loading account…";
    const account = rows.find((row) => row.viewer === login);
    el("account-dates").textContent = account
      ? "First recorded " +
        date(account.firstSeen) +
        " · Last recorded activity " +
        date(account.lastSeen)
      : "";
    drawRows();
    if (focus) {
      el("detail-name").focus({ preventScroll: true });
      el("account-detail").scrollIntoView({ block: "start" });
    }
    try {
      const data = await api(viewerPath(login) + "/receipts");
      if (ticket !== detailRequest || !inAccounts()) return;
      const items = data.receipts;
      el("untrack-account").hidden = items.length > 0;
      const list = el("account-items");
      for (const item of items) {
        const row = node("li");
        row.append(
          node("strong", item.reward),
          node(
            "p",
            campaignName(item) + " · Confirmed " + date(item.recordedAt),
            "muted",
          ),
        );
        if (item.codeSavedAt) row.append(codeActions(item, login, ticket));
        list.append(row);
      }
      choices = [
        giveaway,
        ...items.filter(
          (item) =>
            item.campaignId !== chatCampaignId && !sameAward(item, giveaway),
        ),
      ].filter(
        (item) =>
          !items.some((saved) => sameAward(item, saved) && saved.codeSavedAt),
      );
      el("code-award").replaceChildren(
        ...choices.map((award, index) => {
          const option = node(
            "option",
            award.reward +
              (award === giveaway ? "" : " · " + campaignName(award)),
          );
          option.value = String(index);
          return option;
        }),
      );
      el("save-code-panel").hidden = choices.length === 0;
      el("account-detail-status").textContent = items.length
        ? ""
        : "No rewards confirmed for this account yet.";
    } catch (err) {
      if (ticket === detailRequest)
        el("account-detail-status").textContent = err.message;
    }
  }

  el("track-account").addEventListener("submit", async (event) => {
    event.preventDefault();
    const control =
      event.submitter || event.currentTarget.querySelector("button");
    const login = el("track-name").value.trim().toLowerCase();
    control.disabled = true;
    try {
      await api(viewerPath(login), "PUT", {});
      if (!inAccounts()) return;
      el("track-name").value = "";
      el("account-search").value = "";
      el("account-filter").value = "all";
      page = 1;
      await loadList();
      if (giveaway && inAccounts()) await openAccount(login, true);
    } catch (err) {
      el("account-status").textContent = err.message;
    } finally {
      control.disabled = false;
    }
  });
  el("save-account-code").addEventListener("submit", async (event) => {
    event.preventDefault();
    const award = choices[Number(el("code-award").value)];
    const login = selected,
      ticket = detailRequest;
    if (!award || !login) return;
    const control =
      event.submitter || event.currentTarget.querySelector("button");
    control.disabled = true;
    try {
      await api(viewerPath(login) + "/code", "PUT", {
        campaignId: award.campaignId,
        reward: award.reward,
        secretCode: el("new-code").value.trim(),
        platform: el("code-platform").value,
        region: el("code-region").value,
      });
      if (ticket !== detailRequest || !inAccounts()) return;
      await loadList();
      if (ticket === detailRequest) await openAccount(login);
    } catch (err) {
      if (ticket === detailRequest)
        el("account-detail-status").textContent = err.message;
    } finally {
      control.disabled = false;
    }
  });
  el("untrack-account").addEventListener("click", async () => {
    const login = selected,
      ticket = detailRequest;
    if (!login) return;
    try {
      await api(viewerPath(login), "DELETE");
      if (ticket !== detailRequest) return;
      clearDetail();
      await loadList();
    } catch (err) {
      if (ticket === detailRequest)
        el("account-detail-status").textContent = err.message;
    }
  });
  el("review-account").addEventListener("click", () => {
    if (selected)
      document.dispatchEvent(
        new CustomEvent("twitch-reward-viewer", { detail: selected }),
      );
  });
  el("account-search").addEventListener("input", () => {
    listRequest++;
    clearTimeout(searchDelay);
    searchDelay = setTimeout(() => {
      if (inAccounts()) {
        page = 1;
        loadList();
      }
    }, 160);
  });
  el("account-filter").addEventListener("change", () => {
    page = 1;
    loadList();
  });
  el("accounts-prev").addEventListener("click", () => {
    if (page > 1) {
      page--;
      loadList();
    }
  });
  el("accounts-next").addEventListener("click", () => {
    if (page < pageCount) {
      page++;
      loadList();
    }
  });
  el("refresh").addEventListener("click", async () => {
    if (!inAccounts()) return;
    const ticket = detailRequest,
      login = selected;
    await loadList();
    if (
      login &&
      ticket === detailRequest &&
      inAccounts() &&
      !el("save-code-panel").open
    )
      await openAccount(login);
  });
  function showTab() {
    const active = inAccounts();
    el("accounts-view").hidden = !active;
    el("campaign-view").hidden = active || window.location.hash === "#farm";
    for (const [id, chosen] of [
      ["tab-campaigns", !active && window.location.hash !== "#farm"],
      ["tab-accounts", active],
    ]) {
      const tab = el(id);
      tab.classList.toggle("is-active", chosen);
      if (chosen) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    }
    if (active) loadList();
    else {
      listRequest++;
      clearDetail();
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      revealSequence++;
      clearReveals();
    }
  });
  window.addEventListener("pagehide", () => {
    revealSequence++;
    clearDetail();
  });
  window.addEventListener("hashchange", showTab);
  setInterval(() => {
    if (inAccounts() && !document.hidden) loadList();
  }, 60_000);
  showTab();
})();
