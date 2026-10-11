// utils/fileLock (2026-10-11): the per-(host,file) lock, its re-entry, and
// afterUnlock — the rule that nothing waits for a second file while holding
// one. Pure: no hosts, no database.
const test = require("node:test");
const assert = require("node:assert/strict");

const { withFileLock, afterUnlock, holdsFileLock, PROVISION_LOCK } = require("../utils/fileLock");

const HOST = { id: "h" };
const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));
// A promise that must settle within `ms`, or the test fails naming `what`.
function within(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(what + " did not finish in " + ms + "ms")), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

test("cycles on ONE file run one at a time, in arrival order", async () => {
  const seen = [];
  let store = 0;
  const cycle = (name, ms) =>
    withFileLock(HOST, "a.json", async () => {
      seen.push(name + ":in");
      const read = store;
      await tick(ms);
      store = read + 1;
      seen.push(name + ":out");
    });
  await Promise.all([cycle("one", 15), cycle("two", 1), cycle("three", 5)]);
  assert.equal(store, 3, "no read-modify-write lost");
  assert.deepEqual(seen, ["one:in", "one:out", "two:in", "two:out", "three:in", "three:out"]);
});

test("cycles on DIFFERENT files overlap", async () => {
  const seen = [];
  await Promise.all([
    withFileLock(HOST, "a.json", async () => { seen.push("a:in"); await tick(15); seen.push("a:out"); }),
    withFileLock(HOST, "b.json", async () => { seen.push("b:in"); await tick(1); seen.push("b:out"); }),
  ]);
  assert.deepEqual(seen, ["a:in", "b:in", "b:out", "a:out"]);
});

test("the same file on two HOSTS is two locks", async () => {
  const seen = [];
  await Promise.all([
    withFileLock({ id: "x" }, "a.json", async () => { seen.push("x:in"); await tick(10); seen.push("x:out"); }),
    withFileLock({ id: "y" }, "a.json", async () => { seen.push("y:in"); seen.push("y:out"); }),
  ]);
  assert.deepEqual(seen, ["x:in", "y:in", "y:out", "x:out"]);
});

test("a failed cycle rejects its own caller and nobody queued behind it", async () => {
  const boom = withFileLock(HOST, "a.json", async () => { throw new Error("boom"); });
  const next = withFileLock(HOST, "a.json", async () => "fine");
  await assert.rejects(boom, /boom/);
  assert.equal(await next, "fine");
});

test("RE-ENTRY: taking the same file again from inside its own cycle runs straight through", async () => {
  // Before 2026-10-11 this call queued behind the cycle it was made from and
  // never ran — a silent hang that also blocked the file for good.
  const order = [];
  const r = await within(
    withFileLock(HOST, "a.json", async () => {
      order.push("outer");
      assert.equal(holdsFileLock(HOST, "a.json"), true);
      const inner = await withFileLock(HOST, "a.json", async () => {
        order.push("inner");
        return 7;
      });
      order.push("after inner");
      return inner + 1;
    }),
    500,
    "the re-entrant cycle",
  );
  assert.equal(r, 8);
  assert.deepEqual(order, ["outer", "inner", "after inner"]);
  assert.equal(holdsFileLock(HOST, "a.json"), false);
  // And the file is free again afterwards.
  assert.equal(await within(withFileLock(HOST, "a.json", async () => "free"), 500, "the next cycle"), "free");
});

test("re-entry is by async context: another caller still waits its turn", async () => {
  const seen = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const holder = withFileLock(HOST, "a.json", async () => { seen.push("holder:in"); await gate; seen.push("holder:out"); });
  await tick();
  const other = withFileLock(HOST, "a.json", async () => { seen.push("other"); });
  await tick(5);
  assert.deepEqual(seen, ["holder:in"], "the second caller is not let in by the first one's hold");
  release();
  await Promise.all([holder, other]);
  assert.deepEqual(seen, ["holder:in", "holder:out", "other"]);
});

test("work a cycle starts and does not await is no longer 'inside' once the cycle is over", async () => {
  let later;
  let release;
  const gate = new Promise((r) => { release = r; });
  await withFileLock(HOST, "a.json", async () => {
    // Detached: keeps running after this cycle has released the file.
    later = (async () => {
      await gate;
      return [holdsFileLock(HOST, "a.json"), await withFileLock(HOST, "a.json", async () => "took its own turn")];
    })();
  });
  const seen = [];
  const busy = withFileLock(HOST, "a.json", async () => { seen.push("busy:in"); release(); await tick(10); seen.push("busy:out"); });
  const [held, took] = await later;
  await busy;
  assert.equal(held, false);
  assert.equal(took, "took its own turn");
  assert.deepEqual(seen, ["busy:in", "busy:out"], "and it waited for the cycle that held the file meanwhile");
});

test("afterUnlock with no lock held runs the step now and hands back its result", async () => {
  assert.equal(await afterUnlock(async () => "done"), "done");
  await assert.rejects(afterUnlock(async () => { throw new Error("its own failure"); }), /its own failure/);
});

test("afterUnlock inside a cycle runs the step after the file is released and before the caller is answered", async () => {
  const order = [];
  const answered = withFileLock(HOST, "a.json", async () => {
    const put = afterUnlock(async () => {
      order.push("step sees the file " + (holdsFileLock(HOST, "a.json") ? "held" : "free"));
      // The file really is free: a cycle on it is granted from inside the step.
      await within(withFileLock(HOST, "a.json", async () => order.push("step took the file")), 500, "the step's own cycle");
    });
    assert.equal(await put, undefined, "resolved at once — waiting here would be waiting for our own lock");
    order.push("cycle body ends");
    return "value";
  }).then((v) => { order.push("caller answered " + v); });
  await within(answered, 1000, "the cycle");
  assert.deepEqual(order, [
    "cycle body ends",
    "step sees the file free",
    "step took the file",
    "caller answered value",
  ]);
});

test("a step put off inside a NESTED cycle waits for the outermost one — no lock is held when it runs", async () => {
  const order = [];
  await within(
    withFileLock(HOST, PROVISION_LOCK, async () => {
      await withFileLock(HOST, "new.json", async () => {
        afterUnlock(async () => {
          order.push(
            "step: provision " + (holdsFileLock(HOST, PROVISION_LOCK) ? "held" : "free") +
              ", new.json " + (holdsFileLock(HOST, "new.json") ? "held" : "free"),
          );
        });
      });
      order.push("inner cycle over, outer still running");
      await tick(5);
      order.push("outer cycle ends");
    }),
    1000,
    "the nested cycles",
  );
  assert.deepEqual(order, [
    "inner cycle over, outer still running",
    "outer cycle ends",
    "step: provision free, new.json free",
  ]);
});

test("a step that fails costs neither the cycle's result nor the steps behind it; a failed cycle still runs its steps", async () => {
  const ran = [];
  const errors = [];
  const realError = console.error;
  console.error = (m) => errors.push(String(m));
  try {
    const v = await withFileLock(HOST, "a.json", async () => {
      afterUnlock(async () => { ran.push("first"); throw new Error("heal broke"); });
      afterUnlock(async () => { ran.push("second"); });
      return "kept";
    });
    assert.equal(v, "kept");
    assert.deepEqual(ran, ["first", "second"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /heal broke/);

    await assert.rejects(
      withFileLock(HOST, "a.json", async () => {
        afterUnlock(async () => { ran.push("after a failed cycle"); });
        throw new Error("cycle failed");
      }),
      /cycle failed/,
    );
    assert.equal(ran.at(-1), "after a failed cycle");
  } finally {
    console.error = realError;
  }
});

test("THE POINT: two cycles that each hold one file and must edit the other's both finish", async () => {
  // Each writes its own file and then has to strip something from the other's
  // (the single-home heal). Waiting for the other file from inside would hang
  // both for good; put off until unlocked, both run.
  const files = { "a.json": ["a"], "b.json": ["b"] };
  const move = (mine, theirs, token) =>
    withFileLock(HOST, mine, async () => {
      const read = files[mine].slice();
      await tick(5); // both are now inside their own file
      files[mine] = read.concat(token);
      afterUnlock(() =>
        withFileLock(HOST, theirs, async () => {
          const cur = files[theirs].slice();
          await tick(2);
          files[theirs] = cur.filter((x) => x !== token);
        }),
      );
    });
  files["a.json"].push("y"); // "y" is moving to b, "x" to a
  files["b.json"].push("x");
  await within(Promise.all([move("a.json", "b.json", "x"), move("b.json", "a.json", "y")]), 1000, "the two cycles");
  assert.deepEqual(files["a.json"].sort(), ["a", "x"]);
  assert.deepEqual(files["b.json"].sort(), ["b", "y"]);
});
