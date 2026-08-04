// Component system — page world.
//
// Injected as a <script> tag, so it can reach `elementor` and `$e` directly.
// It cannot read a content-script global, which is why the few constants it
// shares with component-format.js are repeated here — the same boundary that
// keeps the template-tag regex out of Tools/page-bridge.js. Change one, change
// both; they are marked MIRROR.
//
// This file deliberately owns three things the content script cannot do:
//   - element and settings access (synchronous, no round trip)
//   - the pre-save hook, which must run inside Elementor's save command
//   - override derivation, which has to be synchronous at save time
(function () {
  if (window.__ElementorComponentBridge) return;
  window.__ElementorComponentBridge = true;

  const NS = "elementor-components";

  const respond = (requestId, result) => {
    window.postMessage({ __ns: NS, __response: true, requestId, ...result }, "*");
  };

  // Unsolicited page -> content-script notification. The save hook fires
  // without anyone having asked, so it has no requestId to answer on. Same
  // shape as the pure-reset hook's channel in Tools/page-bridge.js.
  const emit = (event, detail) => {
    window.postMessage({ __ns: NS, __event: event, ...detail }, "*");
  };

  /* -------------------------------------------------------------- MIRROR block */

  const COMP_WIDGET_TITLE = "-(Comp-Data)-";

  const HIDE_FLAGS = {
    hide_desktop: "hidden-desktop",
    hide_tablet_extra: "hidden-tablet_extra",
    hide_tablet: "hidden-tablet",
    hide_mobile_extra: "hidden-mobile_extra",
    hide_mobile: "hidden-mobile",
  };

  const NEVER_INHERIT = new Set(["_element_id", "_element_cache"]);

  // MIRROR of the counter Tools/page-bridge.js hangs its new-element hook off.
  // Two page-world scripts share no scope, so the channel between them is a
  // window property — and it has to exist, because that hook cannot tell one of
  // our creates from the user pressing "+": measured, both traces are exactly
  // ["document/elements/create"].
  //
  // Every element this file creates comes from a parent component's own JSON, so
  // it must land carrying that JSON's spacing. Without this, inserting or syncing
  // an instance had its containers' padding, margin and gap zeroed by Pure
  // Container Reset the moment they appeared.
  const SUPPRESS_KEY = "__ElementorToolsSuppressCreateHook";
  const suppressCreateHook = async (fn) => {
    if (typeof window[SUPPRESS_KEY] !== "number") window[SUPPRESS_KEY] = 0;
    window[SUPPRESS_KEY]++;
    try {
      return await fn();
    } finally {
      window[SUPPRESS_KEY]--;
    }
  };

  // Elementor keeps global-value and dynamic-tag references in their OWN
  // side-objects, keyed by control name, rather than in the controls they apply
  // to. Setting a container's background from a global colour writes
  //   __globals__: { background_color: "globals/colors?id=558d48e" }
  // and leaves `background_color` itself untouched.
  //
  // Neither key is a control, so resolveControlKey answers null for both and
  // every path that filters on "is this a control" silently discarded them.
  // That is why changing a base's colour via a global appeared to sync
  // successfully and change nothing: the value was reported as
  // "no such control on this element" and dropped.
  //
  // They are handled as a pair because they have the same shape and the same
  // failure. __dynamic__ holds dynamic tags ("Post Title", ACF fields, …).
  const META_SETTINGS = new Set(["__globals__", "__dynamic__"]);

  const B64_CHUNK = 0x8000;
  const b64encode = (str) => {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += B64_CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + B64_CHUNK));
    }
    return btoa(bin);
  };
  const b64decode = (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  };
  const WRAP_OPEN = "<script>\n/*\n";
  const WRAP_CLOSE = "\n*/\n</script>";
  const PAYLOAD_RE = /\/\*\s*([A-Za-z0-9+/=\s]*?)\s*\*\//;
  const encodePayload = (p) => WRAP_OPEN + b64encode(JSON.stringify(p)) + WRAP_CLOSE;
  const decodePayload = (html) => {
    const m = PAYLOAD_RE.exec(String(html || ""));
    if (!m) return null;
    const body = m[1].replace(/\s+/g, "");
    if (!body) return null;
    try {
      const parsed = JSON.parse(b64decode(body));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_) {
      return null;
    }
  };

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

  /* --------------------------------------------------------------- primitives */

  const getContainer = (id) => {
    if (typeof window.elementor?.getContainer !== "function") {
      throw new Error("elementor.getContainer is unavailable");
    }
    const c = window.elementor.getContainer(id);
    if (!c) throw new Error("No container for id " + id);
    return c;
  };

  const runCommand = async (name, args) => {
    if (typeof window.$e?.run !== "function") {
      throw new Error("$e.run is unavailable");
    }
    return await window.$e.run(name, args);
  };

  const childContainers = (container) => {
    const kids = container?.children;
    if (Array.isArray(kids)) return kids;
    if (kids && typeof kids.length === "number") return Array.from(kids);
    return [];
  };

  const titleOf = (c) => {
    const t = c?.settings?.get?.("_title");
    return t ? String(t).trim() : "";
  };

  const typeOf = (c) => c?.model?.get?.("elType") || null;
  const widgetOf = (c) => c?.model?.get?.("widgetType") || null;

  const isCompWidget = (c) =>
    widgetOf(c) === "html" && titleOf(c) === COMP_WIDGET_TITLE;

  const previewRoot = () => {
    if (typeof window.elementor?.getPreviewContainer !== "function") {
      throw new Error("elementor.getPreviewContainer is unavailable");
    }
    return window.elementor.getPreviewContainer();
  };

  /* ------------------------------------------------------------- document info */

  // Whether this editor is editing a library template rather than a page. The
  // URL Elementor builds for "all posts of this type" names the post type
  // outright, which beats testing document.type against a list of template type
  // names that grows with each Elementor release.
  // The post's own title, which is what a base component is named after — not
  // the root container's layer name, which is a different thing the user may
  // never have set. Elementor keeps it in the document settings model rather
  // than anywhere on `config`, and which of these answers varies by version, so
  // they are tried in order of directness rather than picked.
  const documentTitle = () => {
    const doc = window.elementor?.documents?.getCurrent?.();
    const candidates = [
      () => doc?.container?.settings?.get?.("post_title"),
      () => window.elementor?.settings?.page?.model?.get?.("post_title"),
      () => doc?.config?.settings?.settings?.post_title,
    ];
    for (const read of candidates) {
      try {
        const value = read();
        if (value && String(value).trim()) return String(value).trim();
      } catch (_) {}
    }
    return "";
  };

  const docInfo = () => {
    const cfg = window.elementor?.documents?.getCurrent?.()?.config || {};
    const allPostType = String(cfg?.urls?.all_post_type || "");
    let roots = [];
    try {
      roots = childContainers(previewRoot());
    } catch (_) {}
    return {
      postId: cfg.id ?? window.elementor?.config?.document?.id ?? null,
      docType: cfg.type ?? null,
      postTitle: documentTitle(),
      status: cfg?.status?.value ?? null,
      isTemplateEditor: allPostType.includes("post_type=elementor_library"),
      rootCount: roots.length,
      // Only meaningful under the single-root rule a component base requires;
      // with several roots there is no one container that is "the component",
      // and the caller refuses rather than picking one.
      rootId: roots.length === 1 ? roots[0].id : null,
      roots: roots.map((r) => ({
        id: r.id,
        title: titleOf(r),
        elType: typeOf(r),
      })),
    };
  };

  /* --------------------------------------------------------------------- scan */

  // Every component in the document, found by its data widget.
  //
  // The scan walks the WHOLE tree, not just the roots. A template can merely
  // *contain* an instance without itself being a component, which is the
  // ordinary case — restricting the walk to top level would find nothing in it.
  // Each data widget's PARENT container is that component's root.
  const scan = () => {
    const found = [];
    const broken = [];
    const walk = (container, depth, path) => {
      childContainers(container).forEach((child, index) => {
        const step = `${path} > [${index}]${typeOf(child) || "?"}`;
        if (isCompWidget(child)) {
          const raw = child.settings?.get?.("html") || "";
          const payload = decodePayload(raw);
          const entry = {
            widgetId: child.id,
            rootId: container.id || null,
            rootTitle: titleOf(container),
            rootType: typeOf(container),
            depth,
            path: step,
            payload,
          };
          // A data widget whose payload will not decode is a component whose
          // identity is gone. Report it as its own category — it is not
          // "no components here", and it must not be silently skipped.
          if (!payload) {
            broken.push({ ...entry, reason: "payload did not decode" });
          } else {
            found.push(entry);
          }
        }
        walk(child, depth + 1, step);
      });
    };
    walk(previewRoot(), 0, "root");
    return { components: found, broken };
  };

  /* ------------------------------------------------------------ tree + settings */

  const describeNode = (c) => ({
    id: c.id,
    title: titleOf(c),
    elType: typeOf(c),
    widgetType: widgetOf(c),
    // The data widget is infrastructure, not content. Leaving it in the tree
    // would make it a node the parent could try to map, override or delete.
    children: childContainers(c).filter((k) => !isCompWidget(k)).map(describeNode),
  });

  // Everything a node has that is not at its control default, plus the control
  // type for each. Diffing against defaults is what keeps this small — a
  // container carries ~900 controls and a handful are ever set — and it is the
  // same trick advancedSettings() uses in Tools/page-bridge.js.
  //
  // The type travels with the value because the reader may be writing it onto a
  // different element kind, where the same key can be a different control.
  const nodeSettings = (c) => {
    const controls = c?.settings?.controls || {};
    const current = c?.settings?.toJSON?.() || {};
    const defaults = c?.settings?.defaults || {};
    const out = {};
    const types = {};
    for (const key of Object.keys(controls)) {
      if (NEVER_INHERIT.has(key)) continue;
      const value = current[key];
      if (value === undefined) continue;
      if (canon(value) === canon(defaults[key])) continue;
      out[key] = value;
      types[key] = controls[key]?.type || null;
    }
    // The meta side-objects are not controls, so the loop above cannot see
    // them. They have to be carried explicitly or the live side reports no
    // globals at all — which read as "the instance has none", and then every
    // comparison against a parent that HAS them produced a phantom difference.
    for (const key of META_SETTINGS) {
      const value = current[key];
      if (!value || typeof value !== "object") continue;
      if (!Object.keys(value).length) continue;
      out[key] = value;
      // No control, so no type to travel with it — which also means the type
      // check in apply-node-settings correctly skips it.
      types[key] = null;
    }
    return { settings: out, types };
  };

  const readSubtree = (id) => {
    const nodes = [];
    const walk = (c, parentId) => {
      const { settings, types } = nodeSettings(c);
      nodes.push({
        id: c.id,
        title: titleOf(c),
        elType: typeOf(c),
        widgetType: widgetOf(c),
        // Carried so the planner can tell that a node the parent MOVED between
        // two existing containers has to be relocated here too. Without it a
        // reparent in the base reads as "no change" and the instance quietly
        // keeps the old layout while reporting itself in sync.
        parentId: parentId || null,
        settings,
        types,
      });
      childContainers(c)
        .filter((k) => !isCompWidget(k))
        .forEach((k) => walk(k, c.id));
    };
    walk(getContainer(id), null);
    return { nodes };
  };

  // Which key a setting actually goes by on a given element. Widgets prefix
  // some controls with an underscore and containers do not, and it is not a
  // rule that can be written down — so ask the live schema, exact match first.
  // MIRROR of resolveControlKey in Tools/page-bridge.js.
  const resolveControlKey = (controls, key) => {
    if (!key) return null;
    if (controls[key]) return key;
    if (key.startsWith("_")) return controls[key.slice(1)] ? key.slice(1) : null;
    return controls[`_${key}`] ? `_${key}` : null;
  };

  /* ------------------------------------------------------- comp-data writing */

  // Writing comp-data must not look like a user edit. A direct model write:
  //   - creates NO history entry, so Ctrl+Z still walks the user's own edits
  //   - fires NO settings hook, so it cannot feed back into anything watching
  //   - is still included in what the next save serialises
  // All three were measured on the target build before this was written.
  //
  // The dirty flag is set only when the payload actually changed. Setting it
  // unconditionally would leave the document permanently dirty and keep
  // Elementor's autosave firing forever.
  const writeCompData = (widgetId, payload) => {
    const widget = getContainer(widgetId);
    if (!isCompWidget(widget)) {
      throw new Error(`${widgetId} is not a component data widget`);
    }
    const next = encodePayload(payload);
    if (widget.settings.get("html") === next) {
      return { widgetId, changed: false };
    }
    widget.settings.set("html", next);
    try {
      window.elementor?.saver?.setFlagEditorChange?.(true);
    } catch (_) {}
    return { widgetId, changed: true };
  };

  /* ------------------------------------------------ resolved-parent value cache

     Override derivation runs inside the pre-save hook, which cannot await a
     network fetch — the save would proceed without it. So the content script
     resolves each instance's parent chain asynchronously (on editor load, and
     after every sync) and pushes the result in here. At save time the diff is
     then a pure local comparison.

     Cold cache is the case that matters: an instance with no resolved values
     yet must have its existing overrides left ALONE. Deriving from nothing
     would produce an empty override set and wipe the user's work. */

  const resolved = new Map(); // instanceId -> { nodeId: { key: value } }

  // Instances whose parent has moved since they were last synced. Derivation is
  // refused for these — see the guard in deriveOverrides.
  const staleInstances = new Set();

  const setResolved = (entries, stale) => {
    let n = 0;
    for (const [instanceId, byNode] of Object.entries(entries || {})) {
      resolved.set(instanceId, byNode || {});
      n++;
    }
    // Replaced wholesale rather than merged: the content script always sends
    // the full picture, and an instance that has just been synced has to drop
    // out of this set or it would never derive again.
    staleInstances.clear();
    for (const id of stale || []) {
      staleInstances.add(id);
      // Evicted, not just flagged. A previous warm may have left values here
      // from when the instance WAS in sync, and derivation would happily use
      // them — the flag alone would not stop it.
      resolved.delete(id);
    }
    return { cached: n, stale: staleInstances.size };
  };

  /* ------------------------------------------------------- override derivation */

  // Overrides are DERIVED, not tracked. At save time each instance's live
  // values are compared against its resolved parent values, and whatever
  // differs is the override set.
  //
  // This is why there is no change-tracking subsystem: nothing to accumulate,
  // nothing to lose when a tab closes, and no feedback loop with our own
  // writes. The consequence is that a field deliberately set to the same value
  // the parent has reads as "not overridden" and will follow the parent later
  // — consistent with how isUnset() treats "equal to default" elsewhere.
  const deriveOverrides = (component) => {
    const payload = component.payload;

    // The parent has moved since this instance was last synced, so a diff
    // against it cannot mean what derivation needs it to mean.
    //
    // Derivation answers "what did the user change HERE?" by comparing the
    // instance against its parent. That only works while the parent is the one
    // the instance was built from. Once the base moves ahead, every field the
    // base changed also "differs" — and gets recorded as an instance override,
    // which pins it forever and stops the next sync from ever delivering it.
    // Merely opening a stale instance was enough, because autosave fires this
    // hook on a timer.
    //
    // So a stale instance derives nothing and keeps the overrides it has.
    // The accepted cost is the other direction: edits made to an instance
    // while it is stale are not recorded, and a sync will overwrite them. That
    // is recoverable and visible (the row is flagged out of date, and the skip
    // is logged); a silently pinned field is neither.
    if (staleInstances.has(payload.instanceId)) {
      return { skipped: "parent has changed since the last sync — sync first" };
    }

    const parentValues = resolved.get(payload.instanceId);
    // Cold cache — say so and change nothing.
    if (!parentValues) return { skipped: "no resolved parent values" };

    const map = payload.map || {};
    const overrides = {};
    let count = 0;

    for (const [parentNodeId, instanceNodeId] of Object.entries(map)) {
      let container = null;
      try {
        container = getContainer(instanceNodeId);
      } catch (_) {
        // The node is gone. That is a structural delete, recorded elsewhere;
        // it is not an override and must not be invented as one here.
        continue;
      }
      const controls = container.settings?.controls || {};
      const defaults = container.settings?.defaults || {};
      const live = nodeSettings(container).settings;
      const base = parentValues[parentNodeId] || {};

      // Both sides are normalised against this element's control defaults
      // before they are compared, and that is load-bearing.
      //
      // The two sides are read asymmetrically and cannot be made to agree any
      // other way: the parent comes from raw _elementor_data, which DOES carry
      // keys whose value equals the control default, while the live side comes
      // from nodeSettings(), which strips exactly those. Measured on a heading
      // whose title was "Add Your Heading Text Here" on both sides — stored in
      // the parent, stripped from the instance — which compared as
      // undefined vs "Add Your Heading Text Here" and recorded a phantom
      // override of `title: null`.
      //
      // That is not cosmetic. An override pins its key forever: planInstance
      // skips any key present in the override set, so a phantom one silently
      // stops that field from ever syncing again. It is the reason editing a
      // field in a base appeared to do nothing.
      //
      // (The old comment on nodeValuesFromJson claimed _elementor_data holds
      // only non-default values. It does not.)
      const forNode = {};
      const handled = new Set();

      // Keys the parent sets. Authoritative, and recorded under the PARENT's
      // spelling — planInstance looks overrides up by the parent's key.
      for (const [key, parentVal] of Object.entries(base)) {
        if (NEVER_INHERIT.has(key)) continue;
        // A key the parent set but this element has no control for cannot be
        // an override — there is nothing here to differ. The meta side-objects
        // are the exception: they are not controls but they ARE real settings,
        // and skipping them meant an instance that picked a different global
        // colour recorded no override and had it reverted on the next sync.
        const mapped = META_SETTINGS.has(key)
          ? key
          : resolveControlKey(controls, key);
        if (!mapped) continue;
        handled.add(mapped);
        const fallback = defaults[mapped];
        const liveVal = live[mapped] === undefined ? fallback : live[mapped];
        const wanted = parentVal === undefined ? fallback : parentVal;
        if (canon(liveVal) !== canon(wanted)) {
          forNode[key] = live[mapped] === undefined ? null : live[mapped];
          count++;
        }
      }

      // Keys only this instance sets. live is already default-stripped, so
      // anything left here genuinely differs from the default and the parent
      // does not speak to it.
      for (const [key, liveVal] of Object.entries(live)) {
        if (NEVER_INHERIT.has(key)) continue;
        const mapped = META_SETTINGS.has(key)
          ? key
          : resolveControlKey(controls, key) || key;
        if (handled.has(mapped)) continue;
        if (canon(liveVal) !== canon(defaults[mapped])) {
          forNode[key] = liveVal;
          count++;
        }
      }

      if (Object.keys(forNode).length) overrides[parentNodeId] = forNode;
    }

    return { overrides, count };
  };

  // Structural differences, derived the same way: which mapped parent nodes no
  // longer exist here, and which children exist here with no parent counterpart.
  const deriveStructure = (component) => {
    const payload = component.payload;
    const map = payload.map || {};
    const mapped = new Set(Object.values(map));

    // A parent node that was NEVER mapped cannot be derived as removed —
    // there is nothing in this document to observe its absence against. That
    // makes it a recorded decision rather than a derivation, so it has to be
    // carried forward instead of recomputed.
    //
    // "Link to Component" is what writes those: pairing an existing container
    // against a base leaves the base's unmatched nodes with no counterpart
    // here, and they are declared removed so a later sync does not insert
    // them. Recomputing this list from the map alone would drop every one of
    // them on the first save, and the next sync would rebuild the container
    // into the base — the opposite of what linking promised.
    const declared = Array.isArray(payload.structure?.removed)
      ? payload.structure.removed.filter((id) => !(id in map))
      : [];
    const removed = [...declared];

    for (const [parentNodeId, instanceNodeId] of Object.entries(map)) {
      try {
        getContainer(instanceNodeId);
      } catch (_) {
        removed.push(parentNodeId);
      }
    }

    // Anything inside the component root that is neither mapped nor the data
    // widget was added by this instance. Anchored to its parent's mapped id so
    // a later parent insert cannot displace it.
    const added = [];
    const inverse = new Map(
      Object.entries(map).map(([parentId, instId]) => [instId, parentId]),
    );
    const walk = (container) => {
      childContainers(container).forEach((child) => {
        if (isCompWidget(child)) return;
        if (!mapped.has(child.id)) {
          const siblings = childContainers(container).filter(
            (s) => !isCompWidget(s),
          );
          const index = siblings.findIndex((s) => s.id === child.id);
          let afterBaseNodeId = null;
          for (let i = index - 1; i >= 0; i--) {
            const prev = inverse.get(siblings[i].id);
            if (prev) {
              afterBaseNodeId = prev;
              break;
            }
          }
          added.push({
            nodeId: child.id,
            parentBaseNodeId: inverse.get(container.id) || null,
            afterBaseNodeId,
          });
          return; // its whole subtree rides along with it
        }
        walk(child);
      });
    };
    try {
      walk(getContainer(component.rootId));
    } catch (_) {}

    return { removed, added };
  };

  /* ------------------------------------------------------------- the save hook

     Writes every instance's derived overrides into its own comp-data widget
     BEFORE the save serialises the document, so comp-data can never be one save
     behind its content. Verified on the target build: a model write inside a
     registerUIBefore hook on document/save/default is included in that same
     save.

     Hooked on the autosave route as well as the explicit one — autosave fires
     on a timer, and a document saved with stale comp-data is exactly the drift
     this exists to prevent. */

  const SAVE_COMMANDS = ["document/save/default", "document/save/auto"];

  let saveHooksRegistered = false;
  let saveHookError = null;

  const refreshAllCompData = (why) => {
    const report = { why, updated: [], skipped: [], failed: [] };
    let scanned;
    try {
      scanned = scan();
    } catch (err) {
      report.failed.push({ reason: String(err?.message || err) });
      return report;
    }
    for (const component of scanned.components) {
      const payload = component.payload;
      if (payload?.role !== "instance") continue;
      try {
        const derived = deriveOverrides(component);
        if (derived.skipped) {
          report.skipped.push({
            instanceId: payload.instanceId,
            name: payload.name,
            reason: derived.skipped,
          });
          continue;
        }
        const structure = deriveStructure(component);
        const next = {
          ...payload,
          overrides: derived.overrides,
          structure,
        };
        const res = writeCompData(component.widgetId, next);
        if (res.changed) {
          report.updated.push({
            instanceId: payload.instanceId,
            name: payload.name,
            overrides: derived.count,
            removed: structure.removed.length,
            added: structure.added.length,
          });
        }
      } catch (err) {
        report.failed.push({
          instanceId: payload?.instanceId || component.widgetId,
          reason: String(err?.message || err),
        });
      }
    }
    return report;
  };

  const registerSaveHooks = () => {
    if (saveHooksRegistered) return true;
    const Before = window.$e?.modules?.hookUI?.Before;
    if (
      typeof Before !== "function" ||
      typeof window.$e?.hooks?.registerUIBefore !== "function"
    ) {
      saveHookError = "$e.hooks UI-before API is unavailable";
      return false;
    }
    try {
      for (const command of SAVE_COMMANDS) {
        class CompDataPreSave extends Before {
          getCommand() {
            return command;
          }
          getId() {
            return `elementor-components-presave--${command}`;
          }
          getConditions() {
            return true;
          }
          apply() {
            // Never let a failure here block the user's save. A stale
            // comp-data is recoverable; a save that will not run is not.
            try {
              const report = refreshAllCompData(command);
              if (
                report.updated.length ||
                report.skipped.length ||
                report.failed.length
              ) {
                emit("comp-data-refreshed", { report });
              }
            } catch (err) {
              emit("comp-data-refreshed", {
                report: { why: command, failed: [{ reason: String(err?.message || err) }] },
              });
            }
          }
        }
        window.$e.hooks.registerUIBefore(new CompDataPreSave());
      }
      saveHooksRegistered = true;
      saveHookError = null;
      return true;
    } catch (err) {
      saveHookError = String(err?.message || err);
      return false;
    }
  };

  /* ---------------------------------------------------------------- structural */

  // Fresh ids for imported nodes. A parent template's JSON carries the ids of
  // the elements it was saved from, and importing it raw re-uses them — which
  // is how a lookup starts resolving to the wrong element. Tools/page-bridge.js
  // documents the full failure; the same rule applies to anything this file
  // imports, so ids are regenerated and the old -> new map is RETURNED, because
  // that map is exactly the instance's parentNodeId -> instanceNodeId map.
  const liveIds = () => {
    const ids = new Set();
    try {
      const walk = (c) => {
        for (const kid of childContainers(c)) {
          if (kid?.id) ids.add(kid.id);
          walk(kid);
        }
      };
      walk(previewRoot());
    } catch (_) {}
    return ids;
  };

  const freshId = (taken) => {
    const helpers = window.elementor?.helpers;
    for (let i = 0; i < 50; i++) {
      const id =
        typeof helpers?.getUniqueID === "function"
          ? helpers.getUniqueID()
          : Math.random().toString(16).slice(2, 9);
      if (!taken.has(id)) {
        taken.add(id);
        return id;
      }
    }
    throw new Error("could not generate a free element id");
  };

  const regenerateIds = (nodes, taken, map) => {
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (node.id !== undefined) {
        const old = node.id;
        node.id = freshId(taken);
        map[old] = node.id;
      }
      if (Array.isArray(node.elements)) node.elements.forEach(walk);
    };
    (Array.isArray(nodes) ? nodes : [nodes]).forEach(walk);
    return map;
  };

  /* -------------------------------------------------------------------- handlers */

  const handlers = {
    ping: () => ({ ready: !!(window.$e && window.elementor) }),

    "doc-info": () => docInfo(),

    scan: () => scan(),

    "describe-subtree": ({ id }) => ({ tree: describeNode(getContainer(id)) }),

    // Everything the navigator decoration needs, in one answer: which
    // containers are component roots, which nodes this instance added, and
    // which carry overrides.
    //
    // One op rather than a scan plus a describe-subtree per component — the
    // navigator repaints on every collapse, expand and edit, and a round trip
    // per component per repaint is the difference between a decoration and a
    // performance problem.
    "component-markers": () => {
      // Split by role, because the two get different banner strengths: a base
      // defines the block and an instance merely follows one, so the base is
      // the louder of the two.
      const baseRoots = [];
      const instanceRoots = [];
      const added = [];
      const overridden = [];
      let found;
      try {
        found = scan();
      } catch (err) {
        return {
          baseRoots,
          instanceRoots,
          added,
          overridden,
          error: String(err?.message || err),
        };
      }

      for (const c of found.components) {
        if (!c.rootId) continue;
        if (c.payload?.role === "instance") instanceRoots.push(c.rootId);
        else baseRoots.push(c.rootId);
      }
      // A component whose payload will not decode is still a component root.
      // It goes in with the bases: its role is precisely what cannot be read,
      // and the louder banner is the right default for something broken.
      for (const b of found.broken) if (b.rootId) baseRoots.push(b.rootId);

      for (const component of found.components) {
        const payload = component.payload;
        if (payload?.role !== "instance") continue;
        const map = payload.map || {};
        const mapped = new Set(Object.values(map));

        // Overrides are derived LIVE when the resolved cache is warm, so a
        // field changed a moment ago is marked without waiting for a save.
        // Cold cache falls back to the last derived set rather than reporting
        // none — an absent marker reads as "not overridden", which is a claim
        // this cannot make with no parent values to compare against.
        let source = payload.overrides || {};
        try {
          const derived = deriveOverrides(component);
          if (!derived.skipped) source = derived.overrides;
        } catch (_) {}
        for (const parentNodeId of Object.keys(source)) {
          const liveId = map[parentNodeId];
          if (liveId) overridden.push(liveId);
        }

        // Anything under the root the map does not cover was added here.
        //
        // The walk does NOT stop at the first unmapped node, unlike
        // deriveStructure — that records a subtree once, this marks rows. A
        // child of an added container is just as new as the container, and
        // leaving it unmarked would read as "this came from the base", which
        // is the opposite of true.
        try {
          const walk = (container) => {
            for (const kid of childContainers(container)) {
              if (isCompWidget(kid)) continue;
              if (!mapped.has(kid.id)) added.push(kid.id);
              walk(kid);
            }
          };
          walk(getContainer(component.rootId));
        } catch (_) {}
      }

      return { baseRoots, instanceRoots, added, overridden };
    },

    "read-subtree-settings": ({ id }) => readSubtree(id),

    "set-resolved": ({ entries, stale }) => setResolved(entries, stale),

    "write-comp-data": ({ widgetId, payload }) => writeCompData(widgetId, payload),

    "refresh-comp-data": ({ why }) => ({ report: refreshAllCompData(why || "manual") }),

    "register-save-hooks": () => {
      const ok = registerSaveHooks();
      return { registered: ok, error: saveHookError };
    },

    // Create the data widget that makes a container a component. Built with the
    // hide flags already on, so the widget can never render a gap even for the
    // one save between creation and someone noticing.
    "create-comp-widget": async ({ intoId, payload }) => {
      const parent = getContainer(intoId);
      if (!parent) throw new Error(`No container ${intoId}`);
      const existing = childContainers(parent).find(isCompWidget);
      if (existing) {
        return { widgetId: existing.id, created: false };
      }
      const result = await suppressCreateHook(() =>
        runCommand("document/elements/create", {
          container: parent,
          model: {
            elType: "widget",
            widgetType: "html",
            settings: {
              html: encodePayload(payload),
              _title: COMP_WIDGET_TITLE,
              ...HIDE_FLAGS,
            },
          },
          // The default opens the panel for the new element, which would yank the
          // user away from whatever they were doing to show them an empty widget.
          options: { edit: false, at: 0 },
        }),
      );
      const created = Array.isArray(result)
        ? result.flat(Infinity).find((c) => c && c.id)
        : result;
      if (!created?.id) throw new Error("create returned no element id");
      return { widgetId: created.id, created: true };
    },

    // Write merged values onto instance nodes. Keys are resolved against each
    // target's own control list, so one payload works on containers and widgets
    // alike, and a key that resolves to a different control type is dropped
    // rather than written as garbage.
    "apply-node-settings": async ({ items }) => {
      const results = [];
      for (const item of Array.isArray(items) ? items : []) {
        let target;
        try {
          target = getContainer(item.id);
        } catch (err) {
          results.push({ id: item.id, error: String(err?.message || err) });
          continue;
        }
        const controls = target.settings?.controls || {};
        const settings = {};
        const applied = [];
        const dropped = [];
        for (const [key, value] of Object.entries(item.settings || {})) {
          if (NEVER_INHERIT.has(key)) continue;

          // The meta side-objects are keyed by CONTROL NAME, so their contents
          // get the underscore remapping rather than the key itself — a widget
          // spells the same control `_background_color` where a container has
          // `background_color`. Written whole: it is one settings key as far as
          // Elementor is concerned, so the parent's set is authoritative for it.
          if (META_SETTINGS.has(key)) {
            const remapped = {};
            for (const [control, ref] of Object.entries(value || {})) {
              const target = resolveControlKey(controls, control);
              if (target) remapped[target] = ref;
              else {
                dropped.push({
                  key: `${key}.${control}`,
                  why: "no such control on this element",
                });
              }
            }
            settings[key] = remapped;
            applied.push(key);
            continue;
          }

          const mapped = resolveControlKey(controls, key);
          if (!mapped) {
            dropped.push({ key, why: "no such control on this element" });
            continue;
          }
          const wantType = item.types?.[key];
          const haveType = controls[mapped]?.type;
          if (wantType && haveType && wantType !== haveType) {
            dropped.push({
              key,
              why: `type mismatch (${wantType} vs ${haveType})`,
            });
            continue;
          }
          settings[mapped] = value;
          applied.push(mapped);
        }

        const resetKeys = [];
        for (const key of item.reset || []) {
          // A meta side-object is cleared by writing an empty one, not through
          // reset-settings — it has no control and therefore no default for
          // that command to restore.
          if (META_SETTINGS.has(key)) {
            settings[key] = {};
            applied.push(key);
            continue;
          }
          const mapped = resolveControlKey(controls, key);
          if (mapped) resetKeys.push(mapped);
        }

        try {
          if (resetKeys.length) {
            await runCommand("document/elements/reset-settings", {
              containers: [target],
              settings: resetKeys,
            });
          }
          if (applied.length) {
            // These controls carry selectors, so the default render is wanted —
            // render:false would put the value in the model and nowhere on
            // screen. options.external stays off: it re-renders the element,
            // which is what once made a populated container vanish.
            await runCommand("document/elements/settings", {
              containers: [target],
              settings,
            });
          }
        } catch (err) {
          results.push({ id: item.id, error: String(err?.message || err) });
          continue;
        }
        results.push({ id: item.id, applied, dropped, reset: resetKeys.length });
      }
      return { results };
    },

    // Import nodes from a parent's JSON into this document, returning the
    // old -> new id map so the caller can record it as the instance's node map.
    "insert-nodes": async ({ intoId, afterId, nodes }) => {
      // No intoId means the end of the document. The preview container is the
      // document root and getContainer cannot resolve it by id, so it is taken
      // directly — the same reason insert-template reads a parent off the
      // anchor object rather than looking it up.
      const container = intoId ? getContainer(intoId) : previewRoot();
      const data = JSON.parse(JSON.stringify(nodes || []));
      const idMap = {};
      regenerateIds(data, liveIds(), idMap);

      let at = null;
      if (afterId) {
        const siblings = childContainers(container);
        const index = siblings.findIndex((s) => s.id === afterId);
        if (index >= 0) at = index + 1;
      }

      const created = [];
      for (const node of data) {
        // Suppressed as a whole: these nodes are the parent component's own
        // elements and must arrive with the parent's spacing, not with Pure
        // Container Reset's zeroes. A node with children is already held out by
        // the hook's own pre-built-content test, but a leaf container is not — and
        // an instance whose root is a leaf is perfectly ordinary.
        const result = await suppressCreateHook(() =>
          runCommand("document/elements/create", {
            container,
            model: node,
            options: {
              edit: false,
              ...(at === null ? {} : { at: at++ }),
            },
          }),
        );
        const made = Array.isArray(result)
          ? result.flat(Infinity).find((c) => c && c.id)
          : result;
        if (made?.id) created.push(made.id);
      }
      return { ids: created, idMap };
    },

    // Relocate elements that ALREADY exist, keeping their ids and their own
    // settings. This is what makes "the parent wrapped an existing node in a new
    // container" work: the node is moved into the new wrapper rather than being
    // re-created there, so the instance keeps the one element — with whatever
    // overrides it carries — instead of ending up with the original plus a copy.
    //
    // document/elements/move preserves the element id, which is what keeps the
    // instance's node map valid across the operation. Verified on this build.
    "move-nodes": async ({ moves }) => {
      const done = [];
      const failed = [];
      for (const mv of Array.isArray(moves) ? moves : []) {
        try {
          const node = getContainer(mv.id);
          const target = getContainer(mv.intoId);
          // Anchored to a sibling rather than a raw index, and resolved here
          // against the live children. An index computed from the parent
          // template would be off by one wherever the data widget sits, and it
          // would drift again as earlier moves land.
          let at = 0;
          if (mv.afterId) {
            const siblings = childContainers(target);
            const i = siblings.findIndex((s) => s.id === mv.afterId);
            at = i < 0 ? siblings.length : i + 1;
          }
          await runCommand("document/elements/move", {
            containers: [node],
            target,
            options: { at },
          });
          done.push(mv.id);
        } catch (err) {
          failed.push({ id: mv.id, error: String(err?.message || err) });
        }
      }
      return { moved: done, failed };
    },

    "delete-nodes": async ({ ids }) => {
      const containers = [];
      const missing = [];
      for (const id of ids || []) {
        try {
          containers.push(getContainer(id));
        } catch (_) {
          missing.push(id);
        }
      }
      if (containers.length) {
        await runCommand("document/elements/delete", { containers });
      }
      return { deleted: containers.map((c) => c.id), missing };
    },

    // Detach: delete the data widgets and nothing else. The container and its
    // whole subtree stay exactly as they are — losing the widget is precisely
    // what turns a component back into an ordinary block, because the widget IS
    // the component's entire identity.
    //
    // Each id is checked before anything is deleted. A stale widget id would
    // otherwise delete whatever element now answers to it, and the caller's
    // list comes from a scan that may be a few edits old.
    "delete-comp-widgets": async ({ widgetIds }) => {
      const containers = [];
      const missing = [];
      const refused = [];
      for (const id of widgetIds || []) {
        let c;
        try {
          c = getContainer(id);
        } catch (_) {
          missing.push(id);
          continue;
        }
        if (!isCompWidget(c)) {
          refused.push({ id, why: "not a component data widget" });
          continue;
        }
        containers.push(c);
      }
      if (containers.length) {
        await runCommand("document/elements/delete", { containers });
      }
      return { deleted: containers.map((c) => c.id), missing, refused };
    },

    "history-start": async ({ title }) => {
      try {
        const logId = window.$e?.internal?.("document/history/start-log", {
          type: "change",
          title: title || "Component sync",
        });
        return { logId: logId ?? null };
      } catch (_) {
        return { logId: null };
      }
    },

    "history-end": async ({ logId }) => {
      if (logId === null || logId === undefined) return {};
      try {
        window.$e?.internal?.("document/history/end-log", { id: logId });
      } catch (_) {}
      return {};
    },
  };

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__ns !== NS || data.__response || data.__event) return;

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
