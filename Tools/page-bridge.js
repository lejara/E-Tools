(function () {
  if (window.__ElementorToolsBridge) return;
  window.__ElementorToolsBridge = true;

  const NS = "elementor-tools";

  const respond = (requestId, result) => {
    window.postMessage(
      { __ns: NS, __response: true, requestId, ...result },
      "*",
    );
  };

  const getContainer = (id) => {
    if (!window.elementor || typeof window.elementor.getContainer !== "function") {
      throw new Error("elementor.getContainer is unavailable");
    }
    const c = window.elementor.getContainer(id);
    if (!c) throw new Error("No container for id " + id);
    return c;
  };

  const runCommand = async (name, args) => {
    if (!window.$e || typeof window.$e.run !== "function") {
      throw new Error("$e.run is unavailable");
    }
    return await window.$e.run(name, args);
  };

  const handlers = {
    ping: () => ({ ready: !!(window.$e && window.elementor) }),
    copy: async ({ id }) => {
      await runCommand("document/elements/copy", {
        containers: [getContainer(id)],
      });
      return {};
    },
    "paste-style": async ({ id }) => {
      await runCommand("document/elements/paste-style", {
        containers: [getContainer(id)],
      });
      return {};
    },
  };

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__ns !== NS || data.__response) return;

    const { requestId, op, payload } = data;
    const handler = handlers[op];
    if (!handler) {
      respond(requestId, { ok: false, error: "Unknown op: " + op });
      return;
    }
    try {
      const result = (await handler(payload || {})) || {};
      respond(requestId, { ok: true, ...result });
    } catch (err) {
      respond(requestId, { ok: false, error: String(err?.message || err) });
    }
  });

  window.postMessage({ __ns: NS, __ready: true }, "*");
})();
