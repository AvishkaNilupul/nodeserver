// "Remember this device" (utils/trustedDevices.js): a ticked login box gives
// the browser a long-lived cookie that signs the admin back in with no
// password or 2FA code. These tests drive the real login, 2FA, logout and
// device routes on a throwaway Express app, with the TrustedDevice model and
// the admins file replaced by in-memory fakes (no database, no prod data).
/* global fetch */
const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const mongoose = require("mongoose");

// ---- fakes (installed BEFORE the routes are required: they destructure) ----
const adminsMod = require("../utils/admins");
let ADMINS = [];
adminsMod.loadAdmins = () => ADMINS.map((a) => ({ ...a }));
adminsMod.getAdminById = (id) => {
  const a = ADMINS.find((x) => x.id === id);
  return a ? { ...a } : null;
};

const totp = require("../utils/totp");
totp.decrypt = () => "secret";
totp.verifyToken = (code) => code === "123456";

const systemLog = require("../utils/systemLog");
systemLog.logEvent = async () => {};

const TrustedDevice = require("../models/TrustedDevice");
const store = new Map();
TrustedDevice.create = async (fields) => {
  const _id = new mongoose.Types.ObjectId();
  const doc = { ...fields, _id, createdAt: new Date() };
  store.set(String(_id), doc);
  return { ...doc };
};
TrustedDevice.findById = async (id) => {
  const d = store.get(String(id));
  return d ? { ...d } : null;
};
TrustedDevice.find = (q) => {
  let rows = [...store.values()].filter((d) => d.adminId === q.adminId);
  const chain = {
    sort() {
      rows.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
      return chain;
    },
    skip(n) {
      rows = rows.slice(n);
      return chain;
    },
    select() {
      return chain;
    },
    lean: async () => rows.map((r) => ({ ...r })),
  };
  return chain;
};
TrustedDevice.deleteOne = async (q) => {
  const key = String(q._id);
  const d = store.get(key);
  if (d && (!q.adminId || d.adminId === q.adminId)) {
    store.delete(key);
    return { deletedCount: 1 };
  }
  return { deletedCount: 0 };
};
TrustedDevice.deleteMany = async (q) => {
  let n = 0;
  for (const [key, d] of [...store]) {
    const hit = q.adminId
      ? d.adminId === q.adminId
      : q._id.$in.map(String).includes(key);
    if (hit) {
      store.delete(key);
      n++;
    }
  }
  return { deletedCount: n };
};
TrustedDevice.updateOne = async (q, u) => {
  const d = store.get(String(q._id));
  if (d) Object.assign(d, u.$set);
  return {};
};

const trustedDevices = require("../utils/trustedDevices");
const adminAuthRoutes = require("../routes/adminAuthRoutes");
const twoFactorRoutes = require("../routes/twoFactorRoutes");
const trustedDeviceRoutes = require("../routes/trustedDeviceRoutes");
const { requireAdmin, requireSuperadmin } = require("../middleware/auth");

// Only after every model has been compiled: the restore middleware skips its
// lookup while the database is down, so pretend it is up.
Object.defineProperty(mongoose.connection, "readyState", {
  configurable: true,
  get: () => 1,
});

// ---- app + a tiny cookie-jar browser ----
const IPHONE_APP_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

let base;
let server;
let ipSeq = 10;

test.before(async () => {
  ADMINS = [
    {
      id: "boss",
      username: "Boss",
      role: "superadmin",
      password: bcrypt.hashSync("boss-pw", 4),
      totpEnabled: true,
    },
    {
      id: "plain",
      username: "Plain",
      role: "admin",
      password: bcrypt.hashSync("plain-pw", 4),
      totpEnabled: false,
    },
  ];
  const app = express();
  app.set("trust proxy", "loopback");
  app.use(express.json());
  app.use(
    session({
      secret: "test-secret",
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: "strict" },
    }),
  );
  app.use(trustedDevices.restoreTrustedSession);
  app.use(adminAuthRoutes);
  app.use(twoFactorRoutes);
  app.use(trustedDeviceRoutes);
  app.get("/boss-only.html", requireSuperadmin, (req, res) => res.send("ok"));
  app.get("/any-admin", requireAdmin, (req, res) => res.json({ ok: true }));
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = "http://127.0.0.1:" + server.address().port;
});

test.after(() => server && server.close());

class Browser {
  constructor() {
    this.cookies = new Map();
    // Each browser looks like its own client IP, so the login rate limiter
    // (10 per IP) never trips across tests.
    this.ip = "10.0.0." + ipSeq++;
  }
  absorb(res) {
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => {
        const m = /^\s*expires=(.*)$/i.exec(a);
        return m && new Date(m[1]) < new Date();
      });
      if (expired || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  async call(method, path, body, { html = false } = {}) {
    const headers = {
      "user-agent": IPHONE_APP_UA,
      "x-forwarded-for": this.ip,
      accept: html ? "text/html" : "application/json",
    };
    if (this.cookies.size) {
      headers.cookie = [...this.cookies]
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(base + path, {
      method,
      headers,
      redirect: "manual",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    this.absorb(res);
    return res;
  }
  // A new browser session on the same device: the 12 h session cookie is
  // gone, only the remembered-device cookie is left.
  sessionExpired() {
    const b = new Browser();
    b.ip = this.ip;
    if (this.cookies.has("rh_device")) {
      b.cookies.set("rh_device", this.cookies.get("rh_device"));
    }
    return b;
  }
}

async function loginPlain(remember) {
  const b = new Browser();
  const r = await b.call("POST", "/admin-login", {
    username: "plain",
    password: "plain-pw",
    remember,
  });
  assert.strictEqual(r.status, 200);
  return b;
}

// ---- end-to-end ----

test("2FA login with the box ticked remembers the device, and a later visit needs no password or code", async () => {
  const phone = new Browser();
  let r = await phone.call("POST", "/admin-login", {
    username: "Boss",
    password: "boss-pw",
    remember: true,
  });
  assert.deepStrictEqual(await r.json(), { success: true, twofa: true });
  assert.ok(!phone.cookies.has("rh_device"), "not before the code step");

  r = await phone.call("POST", "/admin-2fa", { token: "123456" });
  assert.strictEqual(r.status, 200);
  assert.ok(phone.cookies.has("rh_device"), "device cookie after 2FA");
  assert.strictEqual(store.size, 1);
  const [row] = [...store.values()];
  assert.strictEqual(row.adminId, "boss");
  assert.strictEqual(row.viaTotp, true);
  assert.strictEqual(row.label, "iPhone · Home Screen app");
  assert.ok(!phone.cookies.get("rh_device").includes(row.tokenHash));

  const later = phone.sessionExpired();
  r = await later.call("GET", "/boss-only.html", undefined, { html: true });
  assert.strictEqual(r.status, 200, "guarded page opens straight away");
  r = await later.call("GET", "/whoami");
  const me = (await r.json()).admin;
  assert.strictEqual(me.username, "Boss");
  assert.strictEqual(me.role, "superadmin");
  assert.strictEqual(me.tfa, true);
  store.clear();
});

test("without the box ticked nothing is remembered", async () => {
  const b = await loginPlain(false);
  assert.ok(!b.cookies.has("rh_device"));
  assert.strictEqual(store.size, 0);
  const later = b.sessionExpired();
  const r = await later.call("GET", "/any-admin");
  assert.strictEqual(r.status, 401);
});

test("a wrong secret is refused, the cookie is cleared and the real device keeps working", async () => {
  const b = await loginPlain(true);
  const good = b.cookies.get("rh_device");
  const [id] = good.split(".");
  const forged = new Browser();
  forged.cookies.set("rh_device", id + "." + "A".repeat(43));
  let r = await forged.call("GET", "/boss-only.html", undefined, {
    html: true,
  });
  assert.strictEqual(r.status, 302);
  assert.ok(!forged.cookies.has("rh_device"), "bad cookie cleared");
  assert.strictEqual(store.size, 1, "a guessed id can't delete the device");

  r = await b.sessionExpired().call("GET", "/any-admin");
  assert.strictEqual(r.status, 200);
  store.clear();
});

test("changing the password signs remembered devices out", async () => {
  const b = await loginPlain(true);
  const plain = ADMINS.find((a) => a.id === "plain");
  const oldHash = plain.password;
  plain.password = bcrypt.hashSync("new-pw", 4);
  try {
    const later = b.sessionExpired();
    const r = await later.call("GET", "/any-admin");
    assert.strictEqual(r.status, 401);
    assert.ok(!later.cookies.has("rh_device"));
    assert.strictEqual(store.size, 0, "stale device row deleted");
  } finally {
    plain.password = oldHash;
  }
});

test("a device trusted before 2FA was turned on is refused", async () => {
  const b = await loginPlain(true);
  const plain = ADMINS.find((a) => a.id === "plain");
  plain.totpEnabled = true;
  try {
    const r = await b.sessionExpired().call("GET", "/any-admin");
    assert.strictEqual(r.status, 401);
    assert.strictEqual(store.size, 0);
  } finally {
    plain.totpEnabled = false;
  }
});

test("an expired device is refused", async () => {
  const b = await loginPlain(true);
  const [row] = [...store.values()];
  row.expiresAt = new Date(Date.now() - 1000);
  const r = await b.sessionExpired().call("GET", "/any-admin");
  assert.strictEqual(r.status, 401);
  assert.strictEqual(store.size, 0);
});

test("logging out forgets this device", async () => {
  const b = await loginPlain(true);
  assert.strictEqual(store.size, 1);
  const r = await b.call("POST", "/admin-logout");
  assert.strictEqual(r.status, 200);
  assert.ok(!b.cookies.has("rh_device"));
  assert.strictEqual(store.size, 0);
});

test("re-ticking the box on a remembered browser replaces its row", async () => {
  const b = await loginPlain(true);
  const r = await b.call("POST", "/admin-login", {
    username: "plain",
    password: "plain-pw",
    remember: true,
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(store.size, 1);
  store.clear();
});

test("Settings lists only your own devices and removes them", async () => {
  const phone = await loginPlain(true);
  const laptop = await loginPlain(true);
  assert.strictEqual(store.size, 2);

  let r = await phone.call("GET", "/me/devices");
  const { devices } = await r.json();
  assert.strictEqual(devices.length, 2);
  assert.strictEqual(devices.filter((d) => d.current).length, 1);
  assert.ok(!("tokenHash" in devices[0]), "no secrets in the list");
  const laptopId = laptop.cookies.get("rh_device").split(".")[0];

  // Another admin can't remove it.
  const boss = new Browser();
  await boss.call("POST", "/admin-login", {
    username: "boss",
    password: "boss-pw",
  });
  await boss.call("POST", "/admin-2fa", { token: "123456" });
  r = await boss.call("POST", `/me/devices/${laptopId}/remove`);
  assert.strictEqual(r.status, 404);
  assert.strictEqual(store.size, 2);

  r = await phone.call("POST", `/me/devices/${laptopId}/remove`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(store.size, 1);
  r = await laptop.sessionExpired().call("GET", "/any-admin");
  assert.strictEqual(r.status, 401, "removed device is signed out");

  r = await phone.call("POST", "/me/devices/remove-all");
  assert.strictEqual(r.status, 200);
  assert.strictEqual(store.size, 0);
  assert.ok(!phone.cookies.has("rh_device"));
});

// ---- small pieces ----

test("signed-out page visits go to login with the page to come back to", async () => {
  const b = new Browser();
  const r = await b.call("GET", "/boss-only.html?tab=2", undefined, {
    html: true,
  });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(
    r.headers.get("location"),
    "/admin-login.html?next=%2Fboss-only.html%3Ftab%3D2",
  );
});

test("readCookie only accepts our exact shape", () => {
  const ok = "0123456789abcdef01234567." + "a".repeat(43);
  const rc = (cookie) => trustedDevices.readCookie({ headers: { cookie } });
  assert.strictEqual(rc(undefined), undefined);
  assert.strictEqual(rc("connect.sid=x"), undefined);
  assert.deepStrictEqual(rc("a=1; rh_device=" + ok), {
    id: "0123456789abcdef01234567",
    token: "a".repeat(43),
  });
  assert.strictEqual(rc("rh_device=junk"), null);
  assert.strictEqual(rc("rh_device=" + ok + "x"), null);
});

test("device labels", () => {
  const d = trustedDevices.describeUserAgent;
  assert.strictEqual(d(IPHONE_APP_UA), "iPhone · Home Screen app");
  assert.strictEqual(
    d(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1",
    ),
    "iPhone · Safari",
  );
  assert.strictEqual(
    d(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    ),
    "Mac · Chrome",
  );
  assert.strictEqual(d(""), "Unknown device");
});
