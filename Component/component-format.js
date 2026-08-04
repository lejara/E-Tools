// Component system — the storage format, and nothing that touches a page.
//
// Loaded BOTH as a content script and by UI/panel.html, the same dual-context
// pattern as template-format.js: the panel lists components and the editor
// authors them, so one side writes a payload the other has to read. A second
// copy of this schema is exactly how the two would drift.
//
// Nothing here may touch `location` or the DOM at load time.
(() => {
  // Bump when the payload shape changes in a way older readers cannot handle.
  // Every payload carries it, so a future reader can migrate rather than guess.
  const SCHEMA_VERSION = 1;

  // The layer name that marks a component's data widget. This string is the
  // entire discovery mechanism — find these, and you have found every component
  // in a document — so it lives in one place and is compared exactly.
  const COMP_WIDGET_TITLE = "-(Comp-Data)-";

  // The data widget must never render. It is an HTML widget holding only a
  // comment, so it has no visible output of its own — but its wrapper div is
  // still a flex child of the component root, and an Elementor container is
  // `display:flex` with a gap. A zero-height child therefore still consumes a
  // gap row and shifts the layout below it. Measured on the test site: the
  // widget rendered on the frontend and took a full gap.
  //
  // Elementor's own responsive-hide switchers are the fix — each emits
  // `elementor-hidden-<device>` (prefix_class "elementor-", return_value
  // "hidden-<device>"), which is display:none, so the element leaves flex flow
  // entirely. Every active breakpoint has to be listed; hiding only desktop
  // leaves the gap on tablet.
  const HIDE_FLAGS = Object.freeze({
    hide_desktop: "hidden-desktop",
    hide_tablet_extra: "hidden-tablet_extra",
    hide_tablet: "hidden-tablet",
    hide_mobile_extra: "hidden-mobile_extra",
    hide_mobile: "hidden-mobile",
  });

  // Controls that must never be copied from a parent onto an instance.
  //
  // _element_id is a CSS id. Two instances of one component on a page would
  // both carry it, which is two DOM elements with the same id — the exact
  // problem template-decouple.js already documents for its multi-root case.
  // _element_cache is widget-only bookkeeping with no meaning on a copy.
  //
  // _title is deliberately NOT here: renaming a layer in the parent should
  // reach its instances, and an instance renaming a layer is a legitimate
  // override like any other. The data widget's own _title is excluded from
  // every tree walk instead, so it can never be treated as content.
  const NEVER_INHERIT = new Set(["_element_id", "_element_cache"]);

  /* ------------------------------------------------------------ value compare */

  // Elementor serialises object keys in an order that is not stable between
  // where a value was produced and where it is read back, so a plain
  // JSON.stringify comparison reports an untouched value as changed. The
  // breakpoint flyout and animation-preset-fields both carry a canon() for this
  // same reason; the failure is silent, which is why it keeps being needed.
  const canon = (value) => {
    const walk = (v) => {
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") {
        const out = {};
        for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
        return out;
      }
      return v;
    };
    try {
      return JSON.stringify(walk(value));
    } catch (_) {
      return String(value);
    }
  };

  const valuesEqual = (a, b) => canon(a) === canon(b);

  /* ------------------------------------------------------------------ base64 */

  // btoa throws on any code point above 0xFF, and override values are arbitrary
  // user text — a heading with an accent or an emoji is enough to break it. So
  // the string is encoded to UTF-8 bytes first and decoded back the same way.
  //
  // The chunking is not decoration: String.fromCharCode(...bytes) spreads the
  // whole array into arguments and blows the call stack on a payload of any
  // real size.
  const B64_CHUNK = 0x8000;

  const b64encode = (str) => {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += B64_CHUNK) {
      bin += String.fromCharCode.apply(
        null,
        bytes.subarray(i, i + B64_CHUNK),
      );
    }
    return btoa(bin);
  };

  const b64decode = (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  };

  /* ------------------------------------------------------------ encode/decode */

  // The payload rides inside an HTML widget as a comment inside a script tag.
  // It is base64 precisely so the data cannot terminate its own container: a
  // raw JSON payload containing "*/" would close the comment early and one
  // containing "</script>" would close the tag, and both corrupt the whole
  // document silently. Base64's alphabet contains neither.
  const WRAP_OPEN = "<script>\n/*\n";
  const WRAP_CLOSE = "\n*/\n</script>";

  // Tolerant on the way in — whitespace inside the comment varies once anything
  // has round-tripped through Elementor — and exact on the way out.
  const PAYLOAD_RE = /\/\*\s*([A-Za-z0-9+/=\s]*?)\s*\*\//;

  const encode = (payload) => WRAP_OPEN + b64encode(JSON.stringify(payload)) + WRAP_CLOSE;

  // Returns null rather than throwing: a widget whose html is hand-edited, or
  // truncated, is a broken component and every caller has to report that
  // anyway. A thrown error here would take out a whole document scan.
  const decode = (html) => {
    const match = PAYLOAD_RE.exec(String(html || ""));
    if (!match) return null;
    const body = match[1].replace(/\s+/g, "");
    if (!body) return null;
    try {
      const parsed = JSON.parse(b64decode(body));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_) {
      return null;
    }
  };

  /* ------------------------------------------------------------------ payloads */

  // Not cryptographic — it only has to not collide within a site. Time prefix
  // keeps ids roughly sortable by creation, which makes a log readable.
  const newId = (prefix) =>
    `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  // A base is a component with no parent. Its content IS the definition, so it
  // carries no overrides, no node map and no chain stamps — there is nothing
  // above it to be out of date with.
  const emptyBase = ({ name, templateId, componentId } = {}) => ({
    v: SCHEMA_VERSION,
    id: componentId || newId("cmp"),
    name: String(name || "Untitled component"),
    role: "base",
    templateId: templateId ?? null,
    parent: null,
  });

  // An instance points at exactly one parent, which must be a template — see
  // `parent` below. Everything else describes how this copy differs from it.
  const emptyInstance = ({
    name,
    componentId,
    instanceId,
    parentTemplateId,
    parentComponentId,
    templateId,
  } = {}) => ({
    v: SCHEMA_VERSION,
    id: componentId || newId("cmp"),
    // Distinct from `id`: several instances of one component share a component
    // id and must still be told apart, which is what the sync rows key on.
    instanceId: instanceId || newId("inst"),
    name: String(name || "Untitled instance"),
    role: "instance",
    // Set only when this instance is *itself* saved as a template, which is
    // what makes it eligible to be someone else's parent.
    templateId: templateId ?? null,
    // The parent is always a template. An instance sitting on a page cannot be
    // a parent: resolving it would mean cross-document reads, and editing that
    // page would silently redefine every descendant. Saving it as a template
    // is what promotes it — which is how base -> instance -> instance chains
    // are built.
    parent: {
      templateId: parentTemplateId ?? null,
      componentId: parentComponentId ?? null,
    },
    // parentNodeId -> thisInstanceNodeId, against the IMMEDIATE parent only.
    // A map flattened to the root base goes wrong the moment a middle link
    // changes its structure; composing two correct maps does not.
    map: {},
    // { parentNodeId: { controlKey: value } }. Keys are concrete control keys
    // including the breakpoint variant ("padding_tablet"), never the family —
    // overriding mobile padding alone has to be expressible.
    overrides: {},
    structure: {
      // Parent node ids this instance has deleted.
      removed: [],
      // Nodes this instance added, which have no parent counterpart. Anchored
      // to a parent node id rather than an index: an index lands in the wrong
      // place as soon as the parent inserts anything above it.
      added: [],
    },
    // Every ancestor resolved at the last sync, with the stamp it had then.
    // The whole chain, not just the immediate parent: A -> B -> C is stale if
    // either A or B moved.
    syncedAgainst: [],
  });

  /* ---------------------------------------------------------------- validation */

  // Structural checks only — whether the payload is internally coherent. It
  // cannot know whether the ids still resolve to anything; that needs a
  // document and belongs to the scanner.
  const validate = (payload) => {
    const errors = [];
    const warnings = [];

    if (!payload || typeof payload !== "object") {
      return { ok: false, errors: ["payload is not an object"], warnings };
    }
    if (payload.v !== SCHEMA_VERSION) {
      // Not fatal on its own — a reader that still understands the shape should
      // say so rather than refuse — but it is the first thing to suspect.
      warnings.push(
        `schema v${payload.v ?? "?"} but this build writes v${SCHEMA_VERSION}`,
      );
    }
    if (!payload.id) errors.push("missing component id");
    if (payload.role !== "base" && payload.role !== "instance") {
      errors.push(`unknown role "${payload.role}"`);
    }

    if (payload.role === "instance") {
      if (!payload.instanceId) errors.push("instance is missing instanceId");
      if (!payload.parent?.templateId) {
        errors.push("instance has no parent template id");
      }
      if (payload.map && typeof payload.map !== "object") {
        errors.push("map is not an object");
      }
      if (payload.overrides && typeof payload.overrides !== "object") {
        errors.push("overrides is not an object");
      }
      const removed = payload.structure?.removed;
      const added = payload.structure?.added;
      if (removed && !Array.isArray(removed)) {
        errors.push("structure.removed is not an array");
      }
      if (added && !Array.isArray(added)) {
        errors.push("structure.added is not an array");
      }
      // An override recorded against a node this instance also deleted can
      // never apply. Harmless, but it means something wrote both.
      if (Array.isArray(removed) && payload.overrides) {
        const clash = removed.filter((id) => payload.overrides[id]);
        if (clash.length) {
          warnings.push(
            `${clash.length} override(s) target deleted node(s): ${clash.join(", ")}`,
          );
        }
      }
    }

    if (payload.role === "base" && payload.parent?.templateId) {
      errors.push("base must not have a parent");
    }

    return { ok: !errors.length, errors, warnings };
  };

  /* ----------------------------------------------------------------- staleness */

  // `stamps` is templateId -> modified_gmt, as returned by one batched REST
  // call over every ancestor in the document. Comparing strings is safe because
  // WordPress emits ISO-8601 in a fixed width; GMT specifically, so a site
  // changing timezone cannot make an instance look fresh.
  //
  // Deliberately biased toward over-warning. A parent that was opened and
  // re-saved with no real change bumps its stamp and lights the icon; running
  // the sync then finds nothing to do and refreshes the stamp, clearing it. The
  // opposite bias — a missed stale instance — is the failure that actually
  // costs something.
  const staleness = (payload, stamps) => {
    if (payload?.role !== "instance") {
      return { state: "base", stale: false, missing: [], changed: [] };
    }
    const chain = Array.isArray(payload.syncedAgainst)
      ? payload.syncedAgainst
      : [];
    const parentId = payload.parent?.templateId;

    if (!parentId) {
      return {
        state: "broken",
        stale: true,
        missing: [],
        changed: [],
        reason: "no parent template id",
      };
    }
    // A parent that no longer exists is a different, louder problem than being
    // out of date: this instance can never sync again.
    if (stamps && !(parentId in stamps)) {
      return {
        state: "broken",
        stale: true,
        missing: [parentId],
        changed: [],
        reason: `parent template ${parentId} not found`,
      };
    }
    // Never synced. Not broken — it just has no baseline yet.
    if (!chain.length) {
      return {
        state: "stale",
        stale: true,
        missing: [],
        changed: [],
        reason: "never synced",
      };
    }

    const missing = [];
    const changed = [];
    for (const entry of chain) {
      const id = entry?.templateId;
      if (id === undefined || id === null) continue;
      const now = stamps?.[id];
      if (now === undefined) {
        missing.push(id);
        continue;
      }
      if (String(now) !== String(entry.modifiedGmt || "")) changed.push(id);
    }

    if (missing.length) {
      return {
        state: "broken",
        stale: true,
        missing,
        changed,
        reason: `ancestor template(s) not found: ${missing.join(", ")}`,
      };
    }
    if (changed.length) {
      return {
        state: "stale",
        stale: true,
        missing,
        changed,
        reason: `ancestor template(s) changed: ${changed.join(", ")}`,
      };
    }
    return { state: "synced", stale: false, missing, changed };
  };

  // What the UI draws. `overridden` is informational rather than a warning —
  // an instance having overrides is the normal case, not a problem.
  const ICONS = Object.freeze({
    broken: { glyph: "⛔", label: "Broken", tone: "error" },
    stale: { glyph: "⚠", label: "Out of date", tone: "warn" },
    overridden: { glyph: "●", label: "Overridden", tone: "info" },
    synced: { glyph: "✓", label: "In sync", tone: "ok" },
    base: { glyph: "◆", label: "Base", tone: "info" },
  });

  const countOverrides = (payload) => {
    let n = 0;
    for (const key of Object.keys(payload?.overrides || {})) {
      n += Object.keys(payload.overrides[key] || {}).length;
    }
    return n;
  };

  /* ------------------------------------------------------------- site index */

  // Bump when the cached index shape changes. A cache written by an older build
  // is discarded rather than migrated: re-earning it costs one Refresh, and
  // reading a half-understood index would show the user a wrong tree.
  const INDEX_VERSION = 1;

  // What one component looks like in the cached site index.
  //
  // Counts, not values. The panel only ever displays "3 override(s)", and an
  // override map holds arbitrary user content — caching the values would put a
  // copy of most of the site's text into storage.local to render a number.
  // `parent` and `syncedAgainst` are kept whole because staleness() reads them
  // directly and they are a handful of short strings.
  const slimComponent = (payload, extra = {}) => {
    const v = validate(payload);
    return {
      id: payload?.id ?? null,
      instanceId: payload?.instanceId ?? null,
      name: payload?.name || "",
      role: payload?.role === "base" ? "base" : "instance",
      parentTemplateId: payload?.parent?.templateId
        ? String(payload.parent.templateId)
        : null,
      parentComponentId: payload?.parent?.componentId ?? null,
      overrideCount: countOverrides(payload),
      mapSize: Object.keys(payload?.map || {}).length,
      removedCount: (payload?.structure?.removed || []).length,
      addedCount: (payload?.structure?.added || []).length,
      syncedAgainst: Array.isArray(payload?.syncedAgainst)
        ? payload.syncedAgainst
        : [],
      valid: v.ok,
      errors: v.errors,
      ...extra,
    };
  };

  // The tree the command centre draws: every base, with its instances beneath
  // it, and their instances beneath them.
  //
  // The edge is the HOST DOCUMENT id — which post the data widget was found in
  // — and never `payload.templateId`. That field is written once at creation
  // and is null on an instance that was later saved as a template, so keying on
  // it would silently orphan every chain built the documented way (save an
  // instance as a template to promote it into a parent).
  const buildIndexTree = (docs) => {
    const list = Array.isArray(docs) ? docs : [];
    const byDoc = new Map();
    const stamps = {};
    for (const doc of list) {
      byDoc.set(String(doc.id), doc);
      stamps[String(doc.id)] = doc.modifiedGmt || "";
    }

    const nodes = [];
    for (const doc of list) {
      for (const comp of doc.components || []) {
        nodes.push({ doc, comp, children: [], depth: 0 });
      }
    }

    // Which component inside the parent template an instance actually points
    // at. A template can hold a base plus nested instances of its own, so the
    // component id disambiguates; failing that the outermost one is the
    // template's own component, which is what findComponentRoot resolves to.
    const pickHost = (doc, componentId) => {
      const comps = doc.components || [];
      if (!comps.length) return null;
      if (componentId) {
        const exact = comps.find((c) => c.id === componentId);
        if (exact) return exact;
      }
      return comps.reduce((a, b) => (b.depth < a.depth ? b : a), comps[0]);
    };

    const nodeFor = new Map(); // "docId:instanceId|componentId" -> node
    for (const node of nodes) {
      nodeFor.set(`${node.doc.id}:${node.comp.instanceId || node.comp.id}`, node);
    }

    const roots = [];
    for (const node of nodes) {
      const pid = node.comp.parentTemplateId;
      if (node.comp.role === "base" || !pid) {
        roots.push(node);
        continue;
      }
      const parentDoc = byDoc.get(pid);
      if (!parentDoc) {
        // The parent template is gone, or lives outside what was scanned.
        // Either way this instance can never sync again — a data problem, so
        // it surfaces at top level rather than being hidden under nothing.
        node.orphanReason = `parent template ${pid} is not on this site — deleted, or outside the scan`;
        roots.push(node);
        continue;
      }
      const hostComp = pickHost(parentDoc, node.comp.parentComponentId);
      const host = hostComp
        ? nodeFor.get(`${parentDoc.id}:${hostComp.instanceId || hostComp.id}`)
        : null;
      if (!host) {
        // The template is still there but is no longer a component. That is a
        // different fact from "deleted" and the usual cause is a detach, so it
        // says so — the two need different fixes.
        node.orphanReason =
          `template ${pid} ("${parentDoc.title || pid}") is no longer a component — ` +
          `its data widget was removed`;
        roots.push(node);
        continue;
      }
      host.children.push(node);
    }

    // The walk BUILDS rather than annotates, and that is the whole reason it is
    // shaped this way. One component can legitimately appear at two places in a
    // chain, so `nodes` entries are shared — writing depth, state or a
    // truncated child list onto them corrupts the other appearance. In
    // particular, clearing children on a cycle stop wiped the real tree and
    // made the looping components disappear entirely.
    //
    // The seen-set is mandatory rather than defensive: a chain that loops back
    // on itself would otherwise recurse until the stack gives out. Same
    // reasoning as collectChain in component-core.js.
    const visited = new Set();
    const build = (node, depth, seen, orphanReason) => {
      visited.add(node);
      const reason = orphanReason || node.orphanReason;
      let state = staleness(payloadShim(node.comp), stamps);
      let icon =
        ICONS[
          !node.comp.valid
            ? "broken"
            : state.state === "synced" && node.comp.overrideCount
              ? "overridden"
              : state.state
        ] || ICONS.synced;
      // A missing parent is louder than being out of date, deliberately: a
      // deleted or detached parent is a data problem, not a freshness one, and
      // no amount of syncing will clear it.
      if (reason) {
        state = { state: "broken", stale: true, reason };
        icon = ICONS.broken;
      }

      const display = { doc: node.doc, comp: node.comp, depth, state, icon, children: [] };
      const key = `${node.doc.id}:${node.comp.instanceId || node.comp.id}`;
      if (seen.has(key)) {
        display.cycle = true;
        return display;
      }
      const nextSeen = new Set(seen);
      nextSeen.add(key);
      display.children = node.children.map((kid) =>
        build(kid, depth + 1, nextSeen, null),
      );
      return display;
    };

    const display = roots.map((r) => build(r, 0, new Set(), null));

    // A chain that loops — A's parent is B and B's parent is A — produces no
    // base, so nothing above reaches either of them and neither would be drawn
    // at all. Silently omitting a component from the one screen that claims to
    // list every component is worse than drawing it oddly, so anything the walk
    // never reached is surfaced at top level and told why.
    for (const node of nodes) {
      if (visited.has(node)) continue;
      display.push(
        build(
          node,
          0,
          new Set(),
          `component chain loops back on itself through template ` +
            `${node.comp.parentTemplateId} — no base to resolve against`,
        ),
      );
    }

    return { roots: display, stamps, total: nodes.length };
  };

  // staleness() expects a payload; the index stores the slim projection. The
  // three fields it actually reads are all kept, so this is a rename rather
  // than a reconstruction.
  const payloadShim = (comp) => ({
    role: comp.role,
    parent: { templateId: comp.parentTemplateId },
    syncedAgainst: comp.syncedAgainst,
  });

  /* ------------------------------------------------- scanning raw document JSON

     component-page.js scans the LIVE document through `elementor`; this scans
     a document's saved `_elementor_data` without opening it, which is the only
     way a site-wide index is possible at all. Both find the same thing by the
     same rule — an html widget titled COMP_WIDGET_TITLE, whose parent container
     is that component's root. */

  const isCompJson = (node) =>
    node?.widgetType === "html" &&
    (node?.settings?._title || "") === COMP_WIDGET_TITLE;

  // Every component in one document's JSON, not just the outermost. A template
  // routinely holds a base plus nested instances, and the tree needs all of
  // them — findComponentRoot in component-core.js answers a different question
  // (which component *is* this template) and deliberately stops at the first.
  const findAllComponents = (elements) => {
    const found = [];
    const broken = [];
    const walk = (nodes, depth) => {
      for (const node of Array.isArray(nodes) ? nodes : []) {
        const kids = Array.isArray(node?.elements) ? node.elements : [];
        const widget = kids.find(isCompJson);
        if (widget) {
          const payload = decode(widget.settings?.html);
          const entry = {
            widgetId: widget.id ?? null,
            rootNodeId: node.id ?? null,
            rootTitle: node.settings?._title || "",
            depth,
          };
          // A widget whose payload will not decode is a component whose
          // identity is gone. It is not "no component here" and must not be
          // dropped silently — the panel shows it as broken.
          if (payload) found.push({ ...entry, payload });
          else broken.push({ ...entry, reason: "payload did not decode" });
        }
        walk(kids, depth + 1);
      }
    };
    walk(elements, 0);
    return { found, broken };
  };

  window.__ElementorComponentFormat = {
    SCHEMA_VERSION,
    INDEX_VERSION,
    COMP_WIDGET_TITLE,
    HIDE_FLAGS,
    NEVER_INHERIT,
    canon,
    valuesEqual,
    b64encode,
    b64decode,
    encode,
    decode,
    newId,
    emptyBase,
    emptyInstance,
    validate,
    staleness,
    countOverrides,
    slimComponent,
    buildIndexTree,
    findAllComponents,
    ICONS,
  };
})();
