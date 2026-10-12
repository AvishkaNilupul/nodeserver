// The SOOP import dialog's file handling (public/soop/account-import.js,
// contract §17): what a dropped or chosen file turns into before anything is sent.
//
// The dialog counts accounts in the browser and the server imports them one
// request at a time, so the two must agree on where one export ends and the
// next begins — and a folder dropped on the page has to come out as exactly the
// cookie files in it, whatever else rides along. The page script is loaded as
// it ships (no copy of its logic lives here), into a context with no DOM: the
// helpers under test are pure, and the dialog itself is checked in a browser
// against the dev harness (scripts/soop-dev-harness.js --cookie-files=<dir>).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { splitCookieExports, parseCookieInput } = require("../utils/soopClient");

const PUBLIC = path.join(__dirname, "..", "public", "soop");
const SRC = fs.readFileSync(path.join(PUBLIC, "account-import.js"), "utf8");

// Runs the page script the way the browser does. Timers are recorded and never
// fired, so nothing is left running; `el` only has to hand back something a
// property can be set on (the veil is the one node built outside the dialog).
function load() {
  const listeners = {};
  const timers = [];
  const sandbox = {
    Soop: { state: null, el: () => ({ hidden: true }), ui: { icon: () => ({}) }, fmt: { num: String, ago: () => "just now" } },
    window: { addEventListener: (type, fn) => { listeners[type] = fn; } },
    document: { body: { appendChild: (node) => node } },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    clearTimeout: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "public/soop/account-import.js" });
  return { ...sandbox.Soop._accountImport, listeners, timers };
}
// Values built inside the page's context have that context's prototypes.
const plain = (v) => JSON.parse(JSON.stringify(v));

// A Cookie-Editor export as it is saved to a file: an indented JSON array.
const jar = (ticket, extra = []) =>
  JSON.stringify(
    [
      { domain: ".sooplive.com", hostOnly: false, name: "AuthTicket", path: "/", session: true, value: ticket },
      { domain: ".sooplive.com", hostOnly: false, name: "_au", path: "/", session: false, value: "0123abcd" },
      ...extra,
    ],
    null,
    4,
  );
const file = (p, text, more = {}) => ({ path: p, size: text == null ? 0 : text.length, at: 1760000000000, text, ...more });

// ---- one export ends where the server says it ends ------------------------------

const PASTES = {
  "one export": jar("t-1"),
  "one export, compact": JSON.stringify(JSON.parse(jar("t-1"))),
  "two back to back": jar("t-1") + jar("t-2"),
  "two with a comma": jar("t-1") + ",\n" + jar("t-2"),
  "three split by blank lines": [jar("t-1"), jar("t-2"), jar("t-3")].join("\n\n\n"),
  "windows line ends": [jar("t-1"), jar("t-2")].join("\r\n\r\n").replace(/\n/g, "\r\n"),
  "a byte-order mark and stray space": "﻿  " + jar("t-1") + "\n\n",
  "one ticket line each": "AuthTicket=aaa\nAuthTicket=bbb; _au=1\n",
  "header lines around a ticket": "_au=1\nAuthTicket=aaa\nAbroadChk=FAIL\nAuthTicket=bbb\n",
  "exports and ticket lines mixed": jar("t-1") + "\nAuthTicket=aaa\n" + jar("t-2"),
  "a bracket inside a value": jar("t-[1]{x}", [{ name: "note", value: 'a "[quoted]" ] bracket' }]) + jar("t-2"),
  "a bracket in the middle of a header line": "AuthTicket=aa[bb]; x={1}\nAuthTicket=cc",
  "a name=value object": JSON.stringify({ AuthTicket: "t-1", _au: "x" }),
  "an unterminated export": jar("t-1").slice(0, -20),
  "nothing recognisable": "this is not a cookie export",
  blank: "   \n  ",
};

test("the browser splits a paste or a file exactly as the server does", () => {
  const { splitCookiePaste } = load();
  for (const [name, text] of Object.entries(PASTES)) {
    assert.deepEqual(plain(splitCookiePaste(text)), splitCookieExports(text), name);
  }
  assert.deepEqual(plain(splitCookiePaste(null)), []);
  assert.deepEqual(plain(splitCookiePaste(undefined)), []);
});

// ---- what one file brings -------------------------------------------------------

test("a saved Cookie-Editor export is one account, and the server can read what is sent for it", () => {
  const { planFile } = load();
  const text = jar("ticket-of-mina");
  const src = planFile(file("exports/mina0101.json", text + "\n", { at: 1760302080000 }), new Set());
  assert.equal(src.name, "mina0101.json");
  assert.equal(src.path, "exports/mina0101.json");
  assert.equal(src.at, 1760302080000);
  assert.equal(src.skip, null);
  assert.equal(src.parts.length, 1);
  // Exactly the export, nothing added or dropped: this string is the request body's `cookies`.
  assert.equal(src.parts[0], text);
  const cookies = parseCookieInput(src.parts[0]);
  assert.deepEqual(cookies.find((c) => c.name === "AuthTicket"), { name: "AuthTicket", value: "ticket-of-mina" });
  assert.equal(cookies.length, 2);
});

test("a file holding several exports is that many accounts, in file order", () => {
  const { planFile } = load();
  const src = planFile(file("all.txt", [jar("a"), jar("b"), "AuthTicket=c; _au=1"].join("\n\n")), new Set());
  assert.equal(src.skip, null);
  assert.deepEqual(plain(src.parts), [jar("a"), jar("b"), "AuthTicket=c; _au=1"]);
});

test("a file with no AuthTicket in it is listed as skipped and sends nothing", () => {
  const { planFile } = load();
  const cases = {
    "notes.txt": "Not a cookie export.\n",
    "settings.json": JSON.stringify({ theme: "dark", columns: ["a", "b"], nested: { n: [1, 2, 3] } }),
    "signed-out.json": JSON.stringify([{ name: "_au", value: "x" }, { name: "AbroadChk", value: "FAIL" }]),
    "empty.json": "",
  };
  for (const [name, text] of Object.entries(cases)) {
    const src = planFile(file(name, text), new Set());
    assert.deepEqual(plain(src.parts), [], name);
    assert.equal(src.skip, "No AuthTicket cookie in it", name);
  }
  // The part of a mixed file that has no ticket is left out; the rest still counts.
  const mixed = planFile(file("mixed.json", JSON.stringify([{ name: "_au", value: "x" }]) + "\n" + jar("a")), new Set());
  assert.deepEqual(plain(mixed.parts), [jar("a")]);
});

test("a file that was not read says why", () => {
  const { planFile } = load();
  const huge = planFile({ path: "dump.json", size: 5 * 1024 * 1024, at: 0, text: null }, new Set());
  assert.equal(huge.skip, "Too large to be a cookie export");
  const broken = planFile({ path: "locked.json", size: 900, at: 0, text: null }, new Set());
  assert.equal(broken.skip, "Could not be read");
  assert.deepEqual(plain([huge.parts, broken.parts, huge.at]), [[], [], 0]);
});

test("the same export is listed once, however often it is dropped", () => {
  const { planFile } = load();
  const have = new Set();
  const first = planFile(file("a.json", jar("same")), have);
  assert.equal(first.parts.length, 1);
  // The same file again, a copy under another name, and a copy with different white space around it.
  for (const again of [file("a.json", jar("same")), file("copy of a.json", jar("same")), file("b.json", "\n\n" + jar("same") + "\r\n")]) {
    const src = planFile(again, have);
    assert.deepEqual(plain(src.parts), []);
    assert.equal(src.skip, "Already in the list");
  }
  // Twice inside one file counts once; another account's export is not a repeat.
  assert.equal(planFile(file("twice.txt", jar("x") + "\n\n" + jar("x")), new Set()).parts.length, 1);
  const other = planFile(file("c.json", jar("different")), have);
  assert.equal(other.skip, null);
  assert.equal(have.size, 2);
});

// ---- what a drop holds ----------------------------------------------------------

// A FileSystemEntry tree as the browser hands it over. Chrome lists a folder in
// batches and ends with an empty one; `batch` is that size.
const fsFile = (fullPath, opts = {}) => ({
  isFile: true, isDirectory: false, fullPath, name: fullPath.split("/").pop(),
  file: (ok, fail) => (opts.broken ? fail(new Error("gone")) : ok({ name: fullPath.split("/").pop(), size: 10, marker: fullPath })),
});
const fsDir = (fullPath, children, { batch = 100, failAfter = Infinity } = {}) => ({
  isFile: false, isDirectory: true, fullPath, name: fullPath.split("/").pop(),
  createReader() {
    let at = 0, calls = 0;
    return {
      readEntries(ok, fail) {
        if (++calls > failAfter) return fail(new Error("unreadable"));
        const slice = children.slice(at, at + batch);
        at += batch;
        return ok(slice);
      },
    };
  },
});
const item = (entry) => ({ kind: "file", webkitGetAsEntry: () => entry, getAsFile: () => null });
const paths = (list) => Array.from(list, (x) => x.path);

test("a dropped folder gives every file in it, however long the listing, with paths inside the folder", async () => {
  const { fromDrop } = load();
  const names = Array.from({ length: 250 }, (_, i) => `acc${String(i).padStart(3, "0")}.json`);
  const folder = fsDir("/exports", names.map((n) => fsFile("/exports/" + n)));
  const got = await fromDrop({ items: [item(folder)] });
  assert.equal(got.length, 250, "a folder is listed 100 entries at a time; all batches must be read");
  assert.deepEqual(paths(got).slice(0, 2), ["exports/acc000.json", "exports/acc001.json"]);
  assert.equal(paths(got)[249], "exports/acc249.json");
  assert.equal(got[0].file.marker, "/exports/acc000.json", "each path keeps its own File");
  assert.ok(!got.more);
});

test("files and folders dropped together, with the clutter a folder carries left out", async () => {
  const { fromDrop } = load();
  const folder = fsDir("/batch", [
    fsFile("/batch/one.json"),
    fsFile("/batch/.DS_Store"),
    fsFile("/batch/._one.json"),
    fsDir("/batch/__MACOSX", [fsFile("/batch/__MACOSX/one.json")]),
    fsDir("/batch/.git", [fsFile("/batch/.git/config")]),
    fsDir("/batch/week2", [fsFile("/batch/week2/two.json"), fsFile("/batch/week2/gone.json", { broken: true })]),
  ]);
  const dt = { items: [{ kind: "string", webkitGetAsEntry: () => null, getAsFile: () => null }, item(fsFile("/loose.json")), item(folder)] };
  assert.deepEqual(paths(await fromDrop(dt)), ["loose.json", "batch/one.json", "batch/week2/two.json"]);
});

test("a drop stops at 500 files and at four folders deep, and says when it stopped short", async () => {
  const { fromDrop } = load();
  const many = fsDir("/big", Array.from({ length: 620 }, (_, i) => fsFile(`/big/f${i}.json`)));
  const got = await fromDrop({ items: [item(many), item(fsFile("/after.json"))] });
  assert.equal(got.length, 500);
  assert.equal(got.more, true);

  const deep = fsDir("/d0", [fsFile("/d0/0.json"), fsDir("/d0/d1", [fsFile("/d0/d1/1.json"), fsDir("/d0/d1/d2", [fsFile("/d0/d1/d2/2.json"),
    fsDir("/d0/d1/d2/d3", [fsFile("/d0/d1/d2/d3/3.json"), fsDir("/d0/d1/d2/d3/d4", [fsFile("/d0/d1/d2/d3/d4/4.json")])])])])]);
  assert.deepEqual(paths(await fromDrop({ items: [item(deep)] })), ["d0/0.json", "d0/d1/1.json", "d0/d1/d2/2.json", "d0/d1/d2/d3/3.json"]);
});

test("a folder that stops answering keeps what it had listed", async () => {
  const { fromDrop } = load();
  const flaky = fsDir("/flaky", Array.from({ length: 150 }, (_, i) => fsFile(`/flaky/f${i}.json`)), { failAfter: 1 });
  assert.equal((await fromDrop({ items: [item(flaky)] })).length, 100);
});

test("a browser without folder support still gets the dropped files", async () => {
  const { fromDrop } = load();
  const a = { name: "a.json", size: 5 }, b = { name: "b.json", size: 6 };
  // No webkitGetAsEntry: fall back to the File of each item.
  const viaItems = await fromDrop({ items: [{ kind: "file", getAsFile: () => a }, { kind: "file", getAsFile: () => b }] });
  assert.deepEqual(paths(viaItems), ["a.json", "b.json"]);
  assert.equal(viaItems[0].file, a);
  // A synthetic drop's items have no entry behind them (webkitGetAsEntry() is null).
  const noEntry = await fromDrop({ items: [{ kind: "file", webkitGetAsEntry: () => null, getAsFile: () => a }] });
  assert.equal(noEntry[0].file, a);
  // No items list at all: the plain FileList.
  assert.deepEqual(paths(await fromDrop({ files: [a, b] })), ["a.json", "b.json"]);
  assert.equal((await fromDrop({})).length, 0);
});

// ---- the page-wide drop target ----------------------------------------------------

test("only a drag that carries files is taken over; text and links stay the browser's", () => {
  const { listeners } = load();
  assert.deepEqual(Object.keys(listeners).sort(), ["dragend", "dragenter", "dragover", "dragstart", "drop"]);
  const drag = (types) => {
    const e = { prevented: 0, dataTransfer: types && { types, dropEffect: "none" }, preventDefault() { e.prevented++; } };
    return e;
  };
  for (const types of [["text/plain"], ["text/uri-list", "text/html"], []]) {
    const over = drag(types), drop = drag(types);
    listeners.dragenter(drag(types));
    listeners.dragover(over);
    listeners.drop(drop);
    assert.equal(over.prevented + drop.prevented, 0, "left alone: " + JSON.stringify(types));
  }
  listeners.dragover(drag(null)); // an event with no DataTransfer at all must not throw
  // Without this the browser would navigate to the dropped file — and show its cookies.
  const over = drag(["Files"]);
  listeners.dragover(over);
  assert.equal(over.prevented, 1);
  assert.equal(over.dataTransfer.dropEffect, "copy");
});

test("an image or link dragged from the page itself is not a file being brought in", () => {
  const { listeners, timers } = load();
  // Chrome puts "Files" on the drag of an <img> that is already on the page.
  const drag = () => {
    const e = { prevented: 0, dataTransfer: { types: ["text/uri-list", "text/html", "Files"], dropEffect: "none" }, preventDefault() { e.prevented++; } };
    return e;
  };
  listeners.dragstart({});
  const over = drag(), drop = drag();
  listeners.dragenter(drag());
  listeners.dragover(over);
  listeners.drop(drop);
  assert.equal(over.prevented + drop.prevented, 0);
  assert.equal(timers.length, 0, "the veil was never shown");
  // Once that drag is over, files from outside are taken again.
  listeners.dragend({});
  const later = drag();
  listeners.dragover(later);
  assert.equal(later.prevented, 1);
});

test("the veil is taken down again if a drag ends without telling the page", () => {
  const { listeners, timers } = load();
  listeners.dragenter({ dataTransfer: { types: ["Files"] } });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1500);
});

// ---- the rules the file has to keep -------------------------------------------------

test("the dialog only ever POSTs a cookie: no log, no storage, no markup built from text", () => {
  for (const banned of ["console.", "localStorage", "sessionStorage", "indexedDB", "innerHTML", "outerHTML", "document.cookie", "insertAdjacentHTML"]) {
    assert.ok(!SRC.includes(banned), `account-import.js must not use ${banned}`);
  }
  const posts = SRC.match(/Soop\.api\.(get|post)\([^)]*\)/g) || [];
  assert.deepEqual(posts, ['Soop.api.post("/accounts/import", body)'], "one call, to the import route");
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|WebSocket/.test(SRC), "everything goes through Soop.api");
});

test("the Accounts tab loads the dialog file, and the kit has the classes it uses", () => {
  const tab = fs.readFileSync(path.join(PUBLIC, "tab-accounts.js"), "utf8");
  assert.ok(tab.includes('"/soop/account-import.js"'), "tab-accounts.js loads the dialog");
  assert.ok(!tab.includes("function splitCookiePaste"), "the dialog lives in one file only");
  const css = fs.readFileSync(path.join(PUBLIC, "soop.css"), "utf8");
  for (const cls of [".s-drop{", ".s-dropveil{", ".s-dropveil>.s-drop{"]) assert.ok(css.includes(cls), `soop.css defines ${cls}`);
  // The veil has to sit above every other layer, or a drop could land on what is under it.
  assert.ok(Number(/\.s-dropveil\{[^}]*z-index:(\d+)/.exec(css)[1]) > 500);
  // Every s- class the dialog names is one the kit defines.
  const used = new Set((SRC.match(/"s-[a-z-]+(?: (?:s|is)-[a-z-]+)*"/g) || []).flatMap((m) => m.slice(1, -1).split(" ")));
  for (const cls of used) assert.ok(css.includes("." + cls), `account-import.js uses .${cls}, which soop.css does not define`);
});
