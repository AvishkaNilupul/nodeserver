(() => {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const list = byId("campaigns");
  const giveaway = byId("giveaway");
  const notice = byId("notice");
  const refresh = byId("refresh");
  let catalog = null;
  let viewer = "";
  let receipts = [];
  let saving = false;
  const dateFormat = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const date = (value) => dateFormat.format(new Date(value));

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function link(text, href, className) {
    const node = element("a", text, className);
    node.href = href;
    node.target = "_blank";
    node.rel = "noopener noreferrer";
    return node;
  }

  function appendCategories(parent, categories) {
    if (!categories?.length) return;
    if (categories.length === 1) {
      const category = categories[0];
      parent.append(link("Watch " + category.name + " ↗", category.url));
      return;
    }
    const choices = element("details");
    choices.append(
      element(
        "summary",
        "Participating categories (" + categories.length + ")",
      ),
    );
    const links = element("div", "", "reward-links");
    for (const category of categories)
      links.append(link(category.name, category.url));
    choices.append(links);
    parent.append(choices);
  }

  function confirmed(campaignId, reward) {
    return receipts.some(
      (item) => item.campaignId === campaignId && item.reward === reward,
    );
  }

  function rewardChoices(campaignId, names, enabled) {
    if (!viewer || !enabled)
      return element("p", names.join(" · "), "reward-items");
    const choices = element("div", "", "reward-checks");
    for (const name of names) {
      const label = element("label");
      const box = element("input");
      box.type = "checkbox";
      box.checked = confirmed(campaignId, name);
      box.disabled = saving;
      box.dataset.campaign = campaignId;
      box.dataset.reward = name;
      label.append(box, document.createTextNode(name));
      choices.append(label);
    }
    return choices;
  }

  function campaignCard(campaign, open) {
    const card = element("details", "", "card reward-card");
    card.dataset.id = campaign.id;
    card.open = open;
    const heading = element("summary");
    if (campaign.image) {
      const image = element("img", "", "reward-art");
      image.src = campaign.image;
      image.alt = "";
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => image.remove(), { once: true });
      heading.append(image);
    }
    const title = element("span", "", "reward-heading");
    const live = campaign.status === "Live";
    const windowText = live
      ? "Ends " + date(campaign.endsAt)
      : "Starts " + date(campaign.startsAt);
    title.append(element("b", campaign.name), element("small", windowText));
    heading.append(
      title,
      element(
        "span",
        campaign.status,
        "ep-badge " + (live ? "is-ok" : "is-accent"),
      ),
    );
    card.append(heading);

    const body = element("div", "", "reward-content");
    if (campaign.summary) body.append(element("p", campaign.summary));
    const actions = element("div", "", "reward-links");
    if (live) appendCategories(actions, campaign.categories);
    actions.append(link("Campaign rules ↗", campaign.detailsUrl));
    body.append(actions);
    for (const group of campaign.groups) {
      const row = element("div", "", "reward-group");
      if (group.label) {
        row.append(element("h3", group.label));
      }
      if (group.rewards.length)
        row.append(rewardChoices(campaign.id, group.rewards, live));
      row.append(element("p", group.requirement));
      if (live && group.categories?.length) {
        const links = element("div", "", "reward-links");
        appendCategories(links, group.categories);
        row.append(links);
      }
      body.append(row);
    }
    card.append(body);
    return card;
  }

  function showGiveaway(award) {
    giveaway.hidden = !award;
    giveaway.replaceChildren();
    if (!award) return;
    const about = award.claimOnly
      ? "The giveaway has ended. Selected viewers can still claim their code in their Twitch inventory."
      : "Twitch selects viewers for a daily giveaway. If you receive a notification, open your Twitch inventory to claim your code. Availability depends on your platform and region.";
    const links = element("div", "", "reward-links");
    links.append(
      link("Open inventory ↗", award.inventoryUrl, "btn"),
      link("Giveaway details ↗", award.detailsUrl),
    );
    giveaway.append(element("h2", award.name), element("p", about));
    if (!award.claimOnly)
      giveaway.append(element("p", "Giveaway ends " + date(award.endsAt)));
    giveaway.append(element("p", "Claim by " + date(award.claimBy)), links);
    if (viewer) giveaway.append(rewardChoices(award.id, [award.name], true));
  }

  let rendered = false;
  function renderCatalog() {
    if (!catalog) return;
    const open = new Set(
      [...list.querySelectorAll("details.reward-card[open]")].map(
        (item) => item.dataset.id,
      ),
    );
    list.replaceChildren(
      ...catalog.campaigns.map((item, i) =>
        campaignCard(item, rendered ? open.has(item.id) : i === 0),
      ),
    );
    if (!catalog.campaigns.length)
      list.append(
        element(
          "p",
          "There are no open or upcoming reward campaigns in the feed.",
          "ep-empty",
        ),
      );
    showGiveaway(catalog.giveaway);
    rendered = true;
  }

  function renderReceipts() {
    byId("viewer-summary").textContent = viewer
      ? " · " + viewer + " · " + receipts.length + " confirmed"
      : "";
    const rows = receipts.map((item) => {
      const row = element("li"),
        undo = element("button", "Undo", "btn btn-sm");
      undo.type = "button";
      undo.setAttribute("aria-label", "Undo confirmation for " + item.reward);
      undo.addEventListener("click", () =>
        saveReceipt(item.campaignId, item.reward, false),
      );
      const title = catalog?.campaigns.find(
        (entry) => entry.id === item.campaignId,
      )?.name;
      row.append(
        element("span", title ? title + " · " + item.reward : item.reward),
        undo,
      );
      return row;
    });
    byId("receipts").replaceChildren(...rows);
  }

  async function requestReceipts(login, options) {
    const response = await fetch(
      "/api/twitch-rewards/viewers/" + encodeURIComponent(login) + "/receipts",
      {
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        ...options,
      },
    );
    if ([401, 403].includes(response.status))
      throw new Error(
        "Sign in with a superadmin account to manage confirmations.",
      );
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.message || "Could not load viewer confirmations.");
    return data;
  }

  async function selectViewer(value) {
    if (saving) return;
    const login = value.trim().toLowerCase();
    saving = true;
    byId("viewer-status").textContent = "Loading " + login + "…";
    try {
      const data = await requestReceipts(login);
      viewer = data.viewer;
      receipts = data.receipts;
      byId("viewer-status").textContent =
        "Recording confirmations for " +
        viewer +
        ". Check earned items in the campaigns below.";
    } catch (error) {
      viewer = "";
      receipts = [];
      byId("viewer-status").textContent = error.message;
    } finally {
      saving = false;
      renderCatalog();
      renderReceipts();
    }
  }

  async function saveReceipt(campaignId, reward, value) {
    if (saving || !viewer) return;
    saving = true;
    const controls = document.querySelectorAll(
      ".reward-checks input, #viewer-form button, #receipts button",
    );
    controls.forEach((control) => {
      control.disabled = true;
    });
    try {
      await requestReceipts(viewer, {
        method: "PUT",
        body: JSON.stringify({ campaignId, reward, confirmed: value }),
      });
      receipts = receipts.filter(
        (item) => item.campaignId !== campaignId || item.reward !== reward,
      );
      if (value) receipts.unshift({ campaignId, reward });
      byId("viewer-status").textContent = value
        ? "Saved for " + viewer + "."
        : "Confirmation removed.";
    } catch (error) {
      byId("viewer-panel").open = true;
      byId("viewer-status").textContent = error.message;
    } finally {
      saving = false;
      controls.forEach((control) => {
        control.disabled = false;
      });
      document.querySelectorAll(".reward-checks input").forEach((box) => {
        box.checked = confirmed(box.dataset.campaign, box.dataset.reward);
        box.disabled = false;
      });
      renderReceipts();
    }
  }

  async function load() {
    if (refresh.disabled) return;
    refresh.disabled = true;
    list.setAttribute("aria-busy", "true");
    try {
      const response = await fetch("/api/twitch-rewards/campaigns", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (response.status === 401 || response.status === 403) {
        catalog = null;
        viewer = "";
        receipts = [];
        renderReceipts();
        list.replaceChildren();
        showGiveaway(null);
        byId("updated").textContent = "";
        throw new Error(
          "Sign in with a superadmin account to view reward campaigns.",
        );
      }
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        if (failure && "giveaway" in failure) showGiveaway(failure.giveaway);
        throw new Error(
          "The reward campaign feed is unavailable. Try Refresh again shortly.",
        );
      }
      catalog = await response.json();
      renderCatalog();
      renderReceipts();
      byId("updated").textContent = "Feed updated " + date(catalog.refreshedAt);
      notice.hidden = !catalog.stale && !catalog.publishedSnapshot;
      notice.textContent = catalog.stale
        ? "The feed is temporarily unavailable. Showing the last successful update."
        : catalog.publishedSnapshot
          ? "Showing the provider’s published snapshot while the live feed is unavailable."
          : "";
    } catch (err) {
      if (!rendered) list.replaceChildren();
      notice.textContent = err.message;
      notice.hidden = false;
    } finally {
      list.setAttribute("aria-busy", "false");
      refresh.disabled = false;
    }
  }

  byId("theme").addEventListener("click", () => window.toggleTheme());
  byId("viewer-form").addEventListener("submit", (event) => {
    event.preventDefault();
    selectViewer(byId("viewer").value);
  });
  document.addEventListener("twitch-reward-viewer", (event) => {
    byId("viewer-panel").open = true;
    byId("viewer").value = event.detail;
    selectViewer(event.detail);
  });
  document.addEventListener("change", (event) => {
    const box = event.target.closest(".reward-checks input");
    if (box) saveReceipt(box.dataset.campaign, box.dataset.reward, box.checked);
  });
  const campaignView = () => !["#accounts", "#farm"].includes(window.location.hash);
  refresh.addEventListener("click", () => {
    if (campaignView()) load();
  });
  window.addEventListener("hashchange", () => {
    if (campaignView()) {
      load();
      if (viewer && !saving) selectViewer(viewer);
    }
  });
  setInterval(
    () => {
      if (!document.hidden && campaignView()) load();
    },
    5 * 60 * 1000,
  );
  if (campaignView()) load();
})();
