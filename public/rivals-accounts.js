(() => {
  "use strict";
  const $ = (s) => document.querySelector(s),
    status = $("#status");
  const el = (tag, text, cls) => {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  };
  async function api(url, method = "GET", body) {
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) {
      location.href = "/admin-login.html";
      throw Error("Sign in required");
    }
    const x = await r.json();
    if (!r.ok || !x.success) throw Error(x.message || "Request failed");
    return x;
  }
  function render(a) {
    const c = el("article", undefined, "account");
    c.append(
      el("h2", a.rivalsUid ? "Profile " + a.rivalsUid : a.id),
      el(
        "span",
        a.verifiedCount + " / " + a.expectedCount + " costumes verified",
        "pill",
      ),
      el("p", "Steam · " + a.phase + " · Twitch " + a.twitchLogin),
    );
    if (a.presentation?.length) {
      c.append(el("h3", "Combined listing pictures"));
      const combined = el("div", undefined, "proofs");
      for (const p of a.presentation) {
        const link = el("a");
        link.href = p.url;
        link.target = "_blank";
        link.rel = "noopener";
        const img = el("img");
        img.src = p.url;
        img.alt = p.label;
        img.loading = "lazy";
        link.append(img, el("span", p.label));
        combined.append(link);
      }
      c.append(combined);
    }
    if (a.sessionRetention)
      c.append(
        el(
          "p",
          "Session kept signed in at your request. The local preparation queue remains locked to this account.",
          "muted",
        ),
      );
    c.append(el("h3", "Original costume proof"));
    const gallery = el("div", undefined, "proofs");
    for (const p of a.proofs) {
      const link = el("a");
      link.href = p.url;
      link.target = "_blank";
      link.rel = "noopener";
      const img = el("img");
      img.src = p.url;
      img.alt = p.hero + " — " + p.costume + " owned inventory";
      img.loading = "lazy";
      link.append(img, el("span", p.hero + " · " + p.costume));
      gallery.append(link);
    }
    c.append(gallery);
    if (a.rewards) {
      const history = el("details");
      history.append(
        el(
          "summary",
          a.rewards.total + " Twitch reward records · view full list",
        ),
        el(
          "p",
          "Twitch claim history; the " +
            a.verifiedCount +
            " inventory-verified costumes above are the listing promise.",
        ),
        el(
          "p",
          a.rewards.receivedChronoTokens.toLocaleString() +
            " Chrono Tokens received in the saved game claim receipt. This records a claim, not a permanent balance.",
        ),
      );
      const groups = el(
          "p",
          Object.entries(a.rewards.groups)
            .map(([k, v]) => v + " " + k)
            .join(" · "),
        ),
        list = el("ul");
      for (const item of a.rewards.items)
        list.append(
          el("li", item.name + (item.count > 1 ? " × " + item.count : "")),
        );
      history.append(groups, list);
      c.append(history);
    }
    const cols = el("div", undefined, "columns"),
      left = el("section"),
      right = el("section");
    left.append(
      el("h3", "Eldorado draft"),
      el(
        "p",
        a.draft.categoryLabel +
          " · Steam country: " +
          (a.draft.country || "Needs verification"),
      ),
    );
    const title = el("input");
    title.value = a.draft.title;
    title.readOnly = true;
    const desc = el("textarea");
    desc.value = a.draft.description;
    desc.readOnly = true;
    left.append(el("label", "Title"), title, el("label", "Description"), desc);
    const copy = el("button", "Copy title and description");
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(title.value + "\n\n" + desc.value);
        status.textContent = "Draft copied.";
      } catch {
        status.textContent = "Select the draft text to copy it.";
      }
    };
    left.append(copy);
    right.append(el("h3", "Trial price"), el("label", "USD"));
    const price = el("input");
    price.type = "number";
    price.min = ".05";
    price.step = ".01";
    price.value = a.draft.priceUsd;
    const save = el("button", "Save draft price");
    price.disabled = !!a.listing;
    save.disabled = !!a.listing;
    save.onclick = async () => {
      save.disabled = true;
      try {
        await api(
          "/api/rivals/preparations/" + encodeURIComponent(a.id) + "/draft",
          "PATCH",
          { priceUsd: Number(price.value) },
        );
        await load();
      } catch (e) {
        status.textContent = e.message;
      } finally {
        save.disabled = false;
      }
    };
    right.append(
      price,
      save,
      el(
        "p",
        `Estimated balance after 10% seller fee: $${a.draft.estimatedNetUsd.toFixed(2)}. Excludes stock, support and withdrawal costs.`,
      ),
      el("h3", "Before publishing"),
    );
    const list = el("ul");
    for (const b of a.blockers) list.append(el("li", b));
    right.append(
      list,
      el(
        "p",
        "This account is held exclusively. Its linked Twitch rewards remain consumed.",
      ),
    );
    if (a.listing) {
      right.append(
        el("h3", "Eldorado listing"),
        el("p", a.listing.status + " · $" + a.listing.priceUsd.toFixed(2)),
      );
      if (a.listing.url) {
        const link = el("a", "Open Eldorado listing");
        link.href = a.listing.url;
        link.target = "_blank";
        link.rel = "noopener";
        right.append(link);
      }
      const update = el("button", "Update listing content");
      update.disabled =
        !a.presentation?.length ||
        !["active", "paused"].includes(a.listing.status);
      update.onclick = async () => {
        update.disabled = true;
        status.textContent = "Updating listing pictures and copy…";
        try {
          await api(
            "/api/rivals/preparations/" +
              encodeURIComponent(a.id) +
              "/update-listing",
            "POST",
            {},
          );
          await load();
        } catch (e) {
          status.textContent = e.message;
        } finally {
          update.disabled = false;
        }
      };
      right.append(update);
    } else {
      const check = el("button", "Check site email delivery");
      check.onclick = async () => {
        check.disabled = true;
        try {
          await api(
            "/api/rivals/preparations/" +
              encodeURIComponent(a.id) +
              "/delivery/check",
            "POST",
            {},
          );
          await load();
        } catch (e) {
          status.textContent = e.message;
        } finally {
          check.disabled = false;
        }
      };
      const publish = el("button", "Publish on Eldorado");
      publish.disabled =
        !!a.blockers.length ||
        ["publishing", "uncertain"].includes(a.publishState);
      publish.onclick = async () => {
        publish.disabled = true;
        status.textContent =
          "Publishing the verified account and costume pictures…";
        try {
          await api(
            "/api/rivals/preparations/" + encodeURIComponent(a.id) + "/publish",
            "POST",
            {},
          );
          await load();
        } catch (e) {
          status.textContent = e.message;
        } finally {
          publish.disabled = false;
        }
      };
      right.append(check, publish);
    }
    cols.append(left, right);
    c.append(cols);
    return c;
  }
  async function load() {
    try {
      const x = await api("/api/rivals/preparations");
      $("#total").textContent = x.summary.total;
      $("#verified").textContent = x.summary.verified;
      $("#permission").textContent =
        x.permission.canSell === true
          ? "Access available"
          : x.permission.canSell === false
            ? "Needs attention"
            : "Not checked";
      const host = $("#accounts");
      host.replaceChildren(...x.accounts.map(render));
      if (!x.accounts.length)
        host.append(
          el(
            "p",
            "No completed game reports imported yet. Held preparations stay protected.",
            "empty",
          ),
        );
      status.textContent = "Updated " + new Date().toLocaleTimeString();
    } catch (e) {
      status.textContent = e.message;
    }
  }
  $("#refresh").onclick = load;
  $("#check").onclick = async () => {
    const b = $("#check");
    b.disabled = true;
    status.textContent = "Checking Eldorado access…";
    try {
      await api("/api/rivals/eldorado/check", "POST", {});
      await load();
    } catch (e) {
      status.textContent = e.message;
    } finally {
      b.disabled = false;
    }
  };
  load();
})();
