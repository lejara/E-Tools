// Component system — content-script side.
//
// Owns the things the page world cannot do: the network, browser.storage, and
// the modal. Everything that touches `elementor` lives in component-page.js and
// is reached through callBridge, exactly the split Tools/core_utils.js uses.
//
// Deliberately reads two existing globals rather than duplicating them:
//   window.__WpRest             — the wp_rest nonce and authenticated GET
//   window.__ElementorTools     — the shared progress modal and log
// Both are content-script globals in this same world, so this is a read, not a
// modification. It does mean load order matters; see manifest.json.
(() => {
  if (!location.search.includes("action=elementor")) return;

  const ns = (window.__ElementorComponents = window.__ElementorComponents || {});
  const fmt = window.__ElementorComponentFormat;
  if (!fmt) return;

  const NS = "elementor-components";
  const BRIDGE_URL = browser.runtime.getURL("Component/component-page.js");
  const BRIDGE_TIMEOUT = 3000;
  const WAIT_LIMIT = 10;

  // Reads never mutate, so a lost message can be re-sent. Everything else is
  // waited on and never repeated — the reasoning is documented at length on
  // REPLAYABLE_OPS in Tools/core_utils.js and applies unchanged.
  const REPLAYABLE_OPS = new Set([
    "ping",
    "doc-info",
    "scan",
    "describe-subtree",
    "read-subtree-settings",
  ]);

  /* ------------------------------------------------------------------ logging */

  // Writes to the same `logs` key the panel already renders, so component
  // activity shows up beside everything else rather than in its own place.
  const log = async (level, message) => {
    try {
      const { logs = [] } = await browser.storage.local.get("logs");
      const next = [{ level, message, time: Date.now() }, ...logs].slice(0, 50);
      await browser.storage.local.set({ logs: next });
    } catch (_) {}
  };

  /* ---------------------------------------------------------------- transport */

  let injected = false;
  let ready = false;
  let readyResolvers = [];
  let nextRequestId = 0;
  const pending = new Map();
  const eventHandlers = new Map();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__ns !== NS) return;
    if (data.__ready) {
      ready = true;
      readyResolvers.forEach((r) => r());
      readyResolvers = [];
      return;
    }
    if (data.__event) {
      for (const cb of eventHandlers.get(data.__event) || []) {
        try {
          cb(data);
        } catch (_) {}
      }
      return;
    }
    if (data.__response && pending.has(data.requestId)) {
      const { resolve, timer } = pending.get(data.requestId);
      pending.delete(data.requestId);
      clearTimeout(timer);
      resolve(data);
    }
  });

  const onBridgeEvent = (event, cb) => {
    if (!eventHandlers.has(event)) eventHandlers.set(event, []);
    eventHandlers.get(event).push(cb);
  };

  const injectBridge = () => {
    if (injected) return;
    injected = true;
    const script = document.createElement("script");
    script.src = BRIDGE_URL;
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  };

  const waitForBridge = () =>
    new Promise((resolve) => {
      if (ready) return resolve();
      readyResolvers.push(resolve);
      setTimeout(resolve, BRIDGE_TIMEOUT);
    });

  // An expired deadline re-arms rather than abandoning the request: the page
  // world is still working, and for a mutation a dropped request is how you get
  // an orphan nobody is expecting. Same contract as Tools/core_utils.js.
  const callBridge = async (op, payload, { timeout, waitLimit, onWait } = {}) => {
    injectBridge();
    await waitForBridge();
    if (!ready) return { ok: false, error: "Component bridge failed to load" };

    const requestId = ++nextRequestId;
    const span = timeout || BRIDGE_TIMEOUT;
    const limit = waitLimit ?? WAIT_LIMIT;
    const replay = REPLAYABLE_OPS.has(op);
    const send = () =>
      window.postMessage({ __ns: NS, requestId, op, payload: payload || {} }, "*");

    return new Promise((resolve) => {
      let waits = 0;
      const expire = () => {
        const entry = pending.get(requestId);
        if (!entry) return;
        waits++;
        const seconds = Math.round((span * waits) / 1000);
        if (waits >= limit) {
          pending.delete(requestId);
          resolve({ ok: false, error: `Timeout on op: ${op} after ${seconds}s` });
          return;
        }
        entry.timer = setTimeout(expire, span);
        try {
          onWait?.({ op, waits, waited: span * waits, replaying: replay });
        } catch (_) {}
        if (replay) send();
      };
      pending.set(requestId, { resolve, timer: setTimeout(expire, span) });
      send();
    });
  };

  /* ------------------------------------------------------------- template REST */

  // A run resolves the same ancestor repeatedly — several instances of one
  // component, or one component appearing at two depths of a chain. The
  // in-flight promise is cached rather than the value so a burst shares one
  // request, and a rejection is evicted so one blip does not poison the tab.
  // Same reasoning as templateContentCache in Tools/page-bridge.js.
  const templateCache = new Map();

  const invalidateTemplates = () => templateCache.clear();

  const fetchTemplate = (templateId) => {
    const key = String(templateId);
    let cached = templateCache.get(key);
    if (cached) return cached;

    cached = (async () => {
      if (!window.__WpRest) throw new Error("__WpRest is unavailable");
      const { json } = await window.__WpRest.getJson(
        `/wp-json/wp/v2/elementor_library/${encodeURIComponent(key)}` +
          `?context=edit&_fields=id,modified_gmt,status,title,meta._elementor_data`,
      );
      const raw = json?.meta?._elementor_data;
      if (!raw) throw new Error(`template ${key} has no Elementor data`);
      let elements;
      try {
        elements = JSON.parse(raw);
      } catch (err) {
        throw new Error(`template ${key} data did not parse`);
      }
      return {
        templateId: key,
        title: json?.title?.raw ?? json?.title?.rendered ?? "",
        modifiedGmt: json?.modified_gmt || "",
        status: json?.status || null,
        elements: Array.isArray(elements) ? elements : [],
      };
    })();

    cached.catch(() => templateCache.delete(key));
    templateCache.set(key, cached);
    return cached;
  };

  // One request for every ancestor's stamp, rather than one per template. This
  // is what makes the out-of-date icons cheap enough to compute every time the
  // UI opens.
  //
  // `_fields` is safe here because this is a COLLECTION endpoint and answers
  // with an array. The trap documented in CLAUDE.md is /wp/v2/types, which
  // answers with an object keyed by slug and returns {} when filtered.
  const fetchStamps = async (templateIds) => {
    const ids = [...new Set((templateIds || []).map(String))].filter(Boolean);
    if (!ids.length) return {};
    if (!window.__WpRest) throw new Error("__WpRest is unavailable");
    const { json } = await window.__WpRest.getJson(
      `/wp-json/wp/v2/elementor_library?include=${ids.join(",")}` +
        `&_fields=id,modified_gmt,title&context=edit&per_page=100`,
    );
    const out = {};
    for (const row of Array.isArray(json) ? json : []) {
      // Absent from the response means the template is gone — the caller reads
      // that as broken, so it must stay absent rather than be defaulted here.
      out[String(row.id)] = row.modified_gmt || "";
    }
    return out;
  };

  /* --------------------------------------------------- reading a template's JSON

     Value resolution reads the parent template's CONTENT directly and does not
     recurse. That is not a shortcut: an instance saved as a template is already
     a materialised copy with its own overrides baked into its elements, so its
     content *is* its resolved state. Syncing C against B therefore uses B as it
     currently stands — and if B is itself stale against A, you sync B first.
     That is the manual flow working as intended, not a gap.

     The chain is still walked, but only to collect staleness stamps. */

  const COMP_TITLE = fmt.COMP_WIDGET_TITLE;

  const isCompNode = (node) =>
    node?.widgetType === "html" && (node?.settings?._title || "") === COMP_TITLE;

  // The outermost container in this JSON that carries a data widget. Outermost
  // because a component template may itself contain nested instances, and the
  // one being resolved is the template's own root component.
  const findComponentRoot = (elements) => {
    const queue = (Array.isArray(elements) ? elements : []).map((el) => ({
      node: el,
      depth: 0,
    }));
    while (queue.length) {
      const { node, depth } = queue.shift();
      const kids = Array.isArray(node?.elements) ? node.elements : [];
      const compWidget = kids.find(isCompNode);
      if (compWidget) {
        const payload = fmt.decode(compWidget.settings?.html);
        return { rootNode: node, compWidget, payload, depth };
      }
      for (const kid of kids) queue.push({ node: kid, depth: depth + 1 });
    }
    return null;
  };

  // nodeId -> settings, for every node under the component root except the data
  // widget itself.
  //
  // NOTE: this is the raw saved set, and it is NOT default-stripped. That was
  // assumed once and is false — measured on a heading whose `title` equalled
  // the control default and was still persisted here. The live side
  // (nodeSettings in component-page.js) DOES strip defaults, so the two
  // disagree about which keys exist, and deriveOverrides has to normalise both
  // against the element's defaults before comparing. Read the long comment
  // there before changing either.
  const nodeValuesFromJson = (rootNode) => {
    const values = {};
    const walk = (node) => {
      if (!node || isCompNode(node)) return;
      values[node.id] = { ...(node.settings || {}) };
      for (const kid of Array.isArray(node.elements) ? node.elements : []) {
        walk(kid);
      }
    };
    walk(rootNode);
    return values;
  };

  // Structure of the parent, as a flat description the merge can walk.
  const nodeTreeFromJson = (rootNode) => {
    const describe = (node) => ({
      id: node.id,
      elType: node.elType || null,
      widgetType: node.widgetType || null,
      title: node.settings?._title || "",
      json: node,
      children: (Array.isArray(node.elements) ? node.elements : [])
        .filter((k) => !isCompNode(k))
        .map(describe),
    });
    return describe(rootNode);
  };

  /* --------------------------------------------------------------- chain walk */

  // Every ancestor of an instance, with its current stamp. Walks up through
  // each template's own component payload. The visited set is mandatory rather
  // than defensive: a component that transitively contains itself would
  // otherwise recurse until the stack gives out.
  const collectChain = async (parentTemplateId, seen = new Set()) => {
    const chain = [];
    let cursor = parentTemplateId ? String(parentTemplateId) : null;

    while (cursor) {
      if (seen.has(cursor)) {
        return { chain, cycle: cursor };
      }
      seen.add(cursor);

      let tpl;
      try {
        tpl = await fetchTemplate(cursor);
      } catch (err) {
        return { chain, missing: cursor, error: String(err?.message || err) };
      }
      chain.push({ templateId: cursor, modifiedGmt: tpl.modifiedGmt });

      const found = findComponentRoot(tpl.elements);
      const nextId = found?.payload?.parent?.templateId;
      cursor = nextId ? String(nextId) : null;
    }
    return { chain };
  };

  /* ------------------------------------------------------------- resolution */

  // Everything the sync and the save-time diff need about one instance's parent.
  const resolveParentFor = async (payload) => {
    const parentTemplateId = payload?.parent?.templateId;
    if (!parentTemplateId) {
      return { ok: false, error: "instance has no parent template id" };
    }

    let tpl;
    try {
      tpl = await fetchTemplate(parentTemplateId);
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }

    const found = findComponentRoot(tpl.elements);
    if (!found) {
      return {
        ok: false,
        error: `template ${parentTemplateId} ("${tpl.title}") holds no component data widget`,
      };
    }
    if (!found.payload) {
      return {
        ok: false,
        error: `template ${parentTemplateId} ("${tpl.title}") has a data widget that did not decode`,
      };
    }

    const { chain, cycle, missing, error } = await collectChain(parentTemplateId);
    if (cycle) {
      return {
        ok: false,
        error: `component chain loops back on template ${cycle} — refusing to resolve`,
      };
    }

    return {
      ok: true,
      template: tpl,
      parentPayload: found.payload,
      rootNode: found.rootNode,
      tree: nodeTreeFromJson(found.rootNode),
      values: nodeValuesFromJson(found.rootNode),
      chain,
      chainIncomplete: missing ? { missing, error } : null,
    };
  };

  /* ----------------------------------------------- warming the save-time cache

     Override derivation happens inside the pre-save hook, which cannot await a
     network fetch. So the resolved parent values are pushed into the page world
     ahead of time — on editor load and after every sync — and the hook then
     diffs synchronously against them.

     A cold entry is the case that matters: the page world leaves an instance's
     existing overrides ALONE when it has no resolved values for it. Deriving
     from nothing would produce an empty override set and wipe the user's work. */

  // Has the parent chain moved since this instance was last synced?
  //
  // Compared against `syncedAgainst`, not against a freshness heuristic: that
  // list IS the baseline the instance's current content corresponds to, which
  // is exactly the question derivation needs answered.
  //
  // No baseline at all counts as stale. A never-synced instance has nothing to
  // diff against that means anything, and refusing to derive leaves its
  // overrides untouched — the conservative direction.
  const isStaleAgainst = (payload, chain) => {
    const previous = new Map(
      (payload?.syncedAgainst || []).map((e) => [
        String(e.templateId),
        String(e.modifiedGmt || ""),
      ]),
    );
    if (!previous.size) return true;
    for (const entry of chain || []) {
      const id = String(entry?.templateId ?? "");
      if (!id) continue;
      if (previous.get(id) !== String(entry.modifiedGmt || "")) return true;
    }
    return false;
  };

  const warmResolved = async ({ quiet = true } = {}) => {
    const scanRes = await callBridge("scan");
    if (!scanRes?.ok) {
      if (!quiet) log("warn", `Components: scan failed — ${scanRes?.error}`);
      return { ok: false, error: scanRes?.error };
    }

    const instances = (scanRes.components || []).filter(
      (c) => c.payload?.role === "instance",
    );
    if (!instances.length) return { ok: true, cached: 0, failed: [] };

    const entries = {};
    const stale = [];
    const failed = [];
    for (const component of instances) {
      const payload = component.payload;
      const resolvedParent = await resolveParentFor(payload);
      if (!resolvedParent.ok) {
        failed.push({
          instanceId: payload.instanceId,
          name: payload.name,
          error: resolvedParent.error,
        });
        continue;
      }
      // A stale instance is reported as stale rather than cached. Derivation
      // against a parent that has moved on records the PARENT's changes as
      // this instance's overrides, which pins them out of every future sync —
      // see the long note on deriveOverrides.
      if (isStaleAgainst(payload, resolvedParent.chain)) {
        stale.push(payload.instanceId);
        continue;
      }
      // Keyed the way the payload's map is keyed: parent node id -> values.
      entries[payload.instanceId] = resolvedParent.values;
    }

    // Always sent when there is anything to say, including a stale list with no
    // entries — the page world clears its stale set from this message, so
    // staying silent would leave a just-synced instance flagged.
    if (Object.keys(entries).length || stale.length) {
      await callBridge("set-resolved", { entries, stale });
    }
    if (failed.length && !quiet) {
      for (const f of failed) {
        log("warn", `Components: could not resolve "${f.name}" — ${f.error}`);
      }
    }
    return { ok: true, cached: Object.keys(entries).length, stale, failed };
  };

  /* ---------------------------------------------------------------- staleness */

  // State per component in the current document, for the icons. One batched
  // stamp request covers every ancestor of every instance on the page.
  const documentState = async () => {
    const scanRes = await callBridge("scan");
    if (!scanRes?.ok) return { ok: false, error: scanRes?.error };

    const components = scanRes.components || [];
    const broken = scanRes.broken || [];

    const wanted = new Set();
    for (const c of components) {
      for (const entry of c.payload?.syncedAgainst || []) {
        if (entry?.templateId) wanted.add(String(entry.templateId));
      }
      const pid = c.payload?.parent?.templateId;
      if (pid) wanted.add(String(pid));
    }

    let stamps = {};
    let stampError = null;
    try {
      stamps = await fetchStamps([...wanted]);
    } catch (err) {
      stampError = String(err?.message || err);
    }

    const rows = components.map((c) => {
      const payload = c.payload;
      const validation = fmt.validate(payload);
      // Without stamps we cannot claim anything about freshness; say unknown
      // rather than showing a green tick we did not earn.
      const state = stampError
        ? { state: "unknown", stale: false, reason: stampError }
        : fmt.staleness(payload, stamps);
      const overrides = fmt.countOverrides(payload);
      return {
        widgetId: c.widgetId,
        rootId: c.rootId,
        rootTitle: c.rootTitle,
        depth: c.depth,
        payload,
        overrides,
        validation,
        ...state,
        icon:
          fmt.ICONS[
            !validation.ok
              ? "broken"
              : state.state === "unknown"
                ? "stale"
                : state.state === "synced" && overrides
                  ? "overridden"
                  : state.state
          ] || fmt.ICONS.synced,
      };
    });

    return { ok: true, rows, broken, stamps, stampError };
  };

  /* -------------------------------------------------------------------- setup */

  // The save hooks are the one thing that must be live from the moment the
  // editor is usable — a save that happens before they attach writes stale
  // comp-data. Warming the resolved cache follows, since the hooks degrade
  // safely while it is cold.
  const boot = async () => {
    const info = await callBridge("doc-info");
    if (!info?.ok) return;
    ns.docInfo = info;

    const hooks = await callBridge("register-save-hooks");
    if (!hooks?.ok || !hooks.registered) {
      log(
        "warn",
        `Components: save hooks not attached — ${hooks?.error || "unknown reason"}. ` +
          `Component data will not refresh on save.`,
      );
    }

    onBridgeEvent("comp-data-refreshed", ({ report }) => {
      for (const u of report?.updated || []) {
        log(
          "info",
          `Component "${u.name}": ${u.overrides} override(s), ` +
            `${u.removed} removed, ${u.added} added`,
        );
      }
      for (const s of report?.skipped || []) {
        // Worth a warning rather than silence: while an instance is skipped,
        // edits made to it are not being recorded as overrides, and a sync
        // will overwrite them. The user needs to know that is the state.
        log(
          "warn",
          `Component "${s.name || s.instanceId}": overrides not updated — ${s.reason}`,
        );
      }
      for (const f of report?.failed || []) {
        log("error", `Component refresh failed — ${f.reason}`);
      }
    });

    await warmResolved({ quiet: true });
  };

  ns.NS = NS;
  ns.log = log;
  ns.callBridge = callBridge;
  ns.onBridgeEvent = onBridgeEvent;
  ns.fetchTemplate = fetchTemplate;
  ns.fetchStamps = fetchStamps;
  ns.invalidateTemplates = invalidateTemplates;
  ns.findComponentRoot = findComponentRoot;
  ns.nodeValuesFromJson = nodeValuesFromJson;
  ns.nodeTreeFromJson = nodeTreeFromJson;
  ns.collectChain = collectChain;
  ns.resolveParentFor = resolveParentFor;
  ns.isStaleAgainst = isStaleAgainst;
  ns.warmResolved = warmResolved;
  ns.documentState = documentState;
  ns.boot = boot;

  // document_idle can still be ahead of Elementor's own boot, so the first
  // doc-info may find nothing. The bridge's own readiness handshake covers the
  // injection race; this covers Elementor not having finished.
  const start = () => {
    let attempts = 0;
    const tick = async () => {
      attempts++;
      const ping = await callBridge("ping", {}, { waitLimit: 1 });
      if (ping?.ok && ping.ready) return boot();
      if (attempts < 20) setTimeout(tick, 500);
    };
    tick();
  };
  start();
})();
