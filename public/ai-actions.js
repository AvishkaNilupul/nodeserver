// Shared client-side executor for coworker actions. Runs in the operator's OWN
// authenticated browser, calling the SAME existing admin endpoints the manual
// UI uses — no server-side executor, no auth bypass. Used by both the Proposals
// inbox and inline "Approve & run" buttons in the AI chat.
//
// No executable action types are registered right now: the web-farm bot
// operations that used to live here went away with the web-token farm. The
// shell stays so both pages keep working and a future action type only has to
// be added to HANDLERS + LABELS.
(function () {
  // type -> async (action, log) => void, where log(msg, cls), cls "" | "ok" | "err"
  const HANDLERS = {};
  // type -> (action) => string shown on the "Approve & run" button
  const LABELS = {};

  window.AIActions = {
    async run(action, log) {
      if (!action || !action.type) throw new Error("no action");
      const fn = HANDLERS[action.type];
      if (!fn) throw new Error("unknown action type: " + action.type);
      return fn(action, log);
    },
    label(action) {
      if (!action || !action.type) return "action";
      const fn = LABELS[action.type];
      return fn ? fn(action) : action.type;
    },
  };
})();
