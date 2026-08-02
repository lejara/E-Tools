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

  // A one-way page → content-script notification, for something that happens
  // without anyone having asked. Every other message here answers a request and
  // carries its requestId; the pure-reset hook fires off an Elementor command
  // instead, so it has nothing to answer on and needs its own channel.
  const emit = (event, detail) => {
    window.postMessage({ __ns: NS, __event: event, ...detail }, "*");
  };

  const getContainer = (id) => {
    if (
      !window.elementor ||
      typeof window.elementor.getContainer !== "function"
    ) {
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

  const childContainers = (container) => {
    const kids = container?.children;
    if (Array.isArray(kids)) return kids;
    if (kids && typeof kids.length === "number") return Array.from(kids);
    return [];
  };

  // Custom navigator name lives in settings._title. When it was never renamed
  // Elementor falls back to a generic label ("Container"), which will never
  // match a real template title — that's the desired outcome, so return "".
  const containerTitle = (container) => {
    const custom = container?.settings?.get?.("_title");
    return custom ? String(custom).trim() : "";
  };

  const describeContainer = (container) => ({
    id: container.id,
    title: containerTitle(container),
    elType: container.model?.get?.("elType") || null,
    widgetType: container.model?.get?.("widgetType") || null,
    children: childContainers(container).map(describeContainer),
  });

  // Controls that structure the Advanced tab rather than hold a value.
  const ADVANCED_LAYOUT_TYPES = new Set([
    "section",
    "tab",
    "tabs",
    "raw_html",
    "heading",
    "divider",
    "deprecated_notice",
    "notice",
    "alert",
  ]);

  // _title is the navigator label, and template-decouple names its own output —
  // transferring it would clobber the template tag. _element_cache is widget-only
  // and has no container twin; naming it here says so rather than leaving it to
  // look like an accidental drop.
  const NEVER_TRANSFER = new Set(["_title", "_element_cache"]);

  // Which key a setting name actually goes by on a given element. Widgets prefix
  // some advanced controls with an underscore and containers do not — _padding
  // vs padding — and it is not a rule that can be written down: a widget carries
  // `_animation` and `_animation_delay` but plain `animation_duration`. So the
  // live schema is asked, in both directions, and callers keep one spelling.
  //
  // Exact match first: a key that exists as-is is never reinterpreted.
  const resolveControlKey = (controls, key) => {
    if (!key) return null;
    if (controls[key]) return key;
    if (key.startsWith("_"))
      return controls[key.slice(1)] ? key.slice(1) : null;
    return controls[`_${key}`] ? `_${key}` : null;
  };

  // The Advanced tab, as data. Only controls the user actually moved off their
  // default are returned: a widget carries ~550 advanced controls and all but a
  // handful are untouched, so the diff against `defaults` is what keeps this
  // small enough to ride along with every scan.
  //
  // The control's `type` travels with the value because the source element is
  // deleted before the value is ever written — apply-advanced-settings has no
  // other way to check that the key it resolves to on the target holds the same
  // shape.
  const advancedSettings = (container) => {
    const controls = container?.settings?.controls || {};
    const current = container?.settings?.toJSON?.() || {};
    const defaults = container?.settings?.defaults || {};
    const out = [];
    for (const [key, def] of Object.entries(controls)) {
      if ((def?.tab || "") !== "advanced") continue;
      if (ADVANCED_LAYOUT_TYPES.has(def?.type)) continue;
      if (NEVER_TRANSFER.has(key)) continue;
      if (JSON.stringify(current[key]) === JSON.stringify(defaults[key])) {
        continue;
      }
      out.push({ key, type: def?.type || null, value: current[key] });
    }
    return out;
  };

  // Element types that can take children. A widget cannot, which is what
  // decides between "insert inside this" and "insert after this".
  const CHILD_BEARING = new Set(["container", "section", "column"]);

  const indexInParent = (container, parent) => {
    const siblings = childContainers(parent);
    const direct = siblings.indexOf(container);
    // children may hand back fresh wrappers, so fall back to matching by id
    return direct < 0
      ? siblings.findIndex((c) => c && c.id === container.id)
      : direct;
  };

  const describeSelected = (container, via) => {
    const elType = container.model?.get?.("elType") || null;
    const parent = container.parent || null;
    return {
      id: container.id,
      title: containerTitle(container),
      elType,
      widgetType: container.model?.get?.("widgetType") || null,
      canHoldChildren: CHILD_BEARING.has(String(elType)),
      parentId: parent?.id || null,
      parentTitle: parent ? containerTitle(parent) : "",
      index: parent ? indexInParent(container, parent) : -1,
      via,
    };
  };

  // Elementor caches nothing here, and a sync run re-inserts the same template
  // repeatedly. Keyed by source:templateId for the lifetime of the page.
  const templateContentCache = new Map();

  const clone = (value) =>
    typeof structuredClone === "function"
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));

  // The cache holds the in-flight *promise*, not the resolved value, so a
  // prefetch and the insert that follows it share one request instead of racing
  // into two. A rejection is evicted — otherwise one failed fetch would poison
  // that template for the lifetime of the page.
  const getTemplateData = (source, templateId, withPageSettings) => {
    if (!window.elementor?.templates?.requestTemplateContent) {
      throw new Error(
        "elementor.templates.requestTemplateContent is unavailable",
      );
    }
    const cacheKey = `${source}:${templateId}:${withPageSettings ? 1 : 0}`;
    let cached = templateContentCache.get(cacheKey);
    if (!cached) {
      // requestTemplateContent hands back a jQuery-style thenable; normalise it
      // so .catch and Promise.all are safe to use on it.
      cached = Promise.resolve(
        window.elementor.templates.requestTemplateContent(source, templateId, {
          data: { with_page_settings: withPageSettings },
        }),
      );
      cached.catch(() => templateContentCache.delete(cacheKey));
      templateContentCache.set(cacheKey, cached);
    }
    return cached;
  };

  // A template's JSON carries the ids of the elements it was saved from, and
  // importing that JSON raw re-uses them. When the template was saved from a
  // container that is still on the page, the import produces a second element
  // with the SAME id — and every lookup afterwards (styling it, deleting the
  // staging copy) can resolve to the wrong one. That is how a style sync deleted
  // the page's own container instead of its temporary copy, and why undo could
  // not put it back: the history entries pointed at the duplicated id too.
  // Elementor's library modal regenerates ids on its way in; calling
  // document/elements/import directly skips that, so do it here.
  // Every id the document currently holds, from one walk. freshId used to ask
  // elementor.getContainer per candidate — a recursive document lookup, asked
  // once per element in the template, so a large template on a large page paid
  // it hundreds of times. One walk answers all of them.
  //
  // An empty set is the safe degradation: it is what the old code effectively
  // used when getContainer threw, and getUniqueID's ids are random anyway.
  const liveIds = () => {
    const ids = new Set();
    let root = null;
    try {
      root = window.elementor?.getPreviewContainer?.() || null;
    } catch (_) {
      return ids;
    }
    if (!root) return ids;
    const walk = (container) => {
      for (const c of childContainers(container)) {
        if (c?.id) ids.add(c.id);
        walk(c);
      }
    };
    walk(root);
    return ids;
  };

  // taken is both the page's ids and the ids handed out so far in this import,
  // so two elements of one template cannot collide with each other either —
  // which the per-candidate getContainer check could not see.
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

  const regenerateIds = (node, taken) => {
    if (Array.isArray(node)) {
      node.forEach((n) => regenerateIds(n, taken));
      return node;
    }
    if (!node || typeof node !== "object") return node;
    if (node.id !== undefined) node.id = freshId(taken);
    if (Array.isArray(node.elements)) {
      node.elements.forEach((n) => regenerateIds(n, taken));
    }
    return node;
  };

  // Top-level elements as they exist in the template JSON, before any import.
  // This is the arbiter for "does this template really have N roots?".
  const templateRoots = (data) => {
    const content = Array.isArray(data?.content)
      ? data.content
      : Array.isArray(data)
        ? data
        : [];
    return content;
  };

  // import and paste both return a nested structure that repeats the same
  // container more than once, so a flat map yields duplicate ids for a single
  // element. Distinct ids means genuinely distinct elements.
  const createdIds = (result, exclude) => {
    const flat = Array.isArray(result) ? result.flat(Infinity) : [result];
    const skip =
      exclude instanceof Set ? exclude : new Set(exclude ? [exclude] : []);
    return [
      ...new Set(
        flat.filter((c) => c && c.id && !skip.has(c.id)).map((c) => c.id),
      ),
    ];
  };

  // Move already-created siblings to a given index within their own parent.
  // import can only append, so this is how a template lands directly after a
  // selected widget instead of at the end of the container. Same copy → paste
  // → delete shuffle as replace-container, and it clobbers the clipboard the
  // same way.
  const moveToIndex = async (ids, parent, at) => {
    const sources = ids.map(getContainer);
    await runCommand("document/elements/copy", { containers: sources });
    const result = await runCommand("document/elements/paste", {
      containers: [parent],
      options: { at },
    });
    const movedIds = createdIds(result, new Set(ids));
    if (!movedIds.length) throw new Error("paste returned no new container");
    await runCommand("document/elements/delete", { containers: sources });
    return movedIds;
  };

  /* ---------------------------------------------- pure container reset */

  // Zeroing a fresh container's box is a *reaction* to an Elementor command
  // rather than a request, so it hangs off $e.hooks and lives here: a hook fires
  // inside the page world and a content script cannot be on the other end of
  // one. Tools/pure-container-reset.js owns nothing but the on/off flag.

  let pureResetEnabled = false;
  // The second, independent option riding the same create hook: force the "link
  // values together" button off. Separate flag rather than a mode of the reset,
  // because the two have different scopes — the reset is about a container's box,
  // this is about every control that has the button.
  let unlinkNewEnabled = false;
  let pureResetHook = null;
  let pureResetError = null;

  // Every route that produces a container by *copying* an existing one, and the
  // reason the hook can tell a fresh container from a copied one at all.
  //
  // All of them funnel through document/elements/create — measured on this
  // build, a paste fires create with elType "container" and
  // "document/elements/paste" sitting in $e.commands.currentTrace. So the trace
  // is the test, and it is exact. The tempting alternative — inferring it from
  // whether the spacing is still at its defaults — would zero a pasted
  // container that happened to have no spacing set, which is precisely the case
  // "don't touch what I pasted" exists to protect.
  const COPY_COMMANDS = new Set([
    "document/elements/paste",
    "document/elements/import",
    "document/elements/duplicate",
    "document/elements/paste-area",
    "document/ui/paste",
    "document/ui/duplicate",
    "editor/browser-import/import",
  ]);

  // This extension's own creates. createContainer builds the wrapper a
  // widget-mode batch insert needs somewhere to put its widgets, and that is not
  // the user adding a container — so it is held out rather than being zeroed as
  // a side effect of a template run. Every *other* tool here reaches the
  // document through paste or import, which COPY_COMMANDS already covers.
  let pureResetSuppressed = 0;

  // The zero value for a box control, by control type. A dimensions control and
  // a gaps control take different shapes, and writing one into the other puts
  // garbage in the model.
  //
  // "0" rather than "": empty means "inherit whatever the kit or theme says",
  // which is the default this feature exists to override.
  // isLinked is deliberately absent here: it is the *other* option's business, and
  // one place decides it (createSettings) so the two cannot disagree. Asserting
  // `true` here — which this did — would quietly re-link a control every time the
  // user dropped an element, whatever the unlink option said.
  const BOX_ZEROS = {
    dimensions: { unit: "px", top: "0", right: "0", bottom: "0", left: "0" },
    gaps: { unit: "px", column: "0", row: "0" },
  };

  // The control types that carry the "link values together" button. Measured on
  // this build, a container has 30 `dimensions` and 10 `gaps` controls and every
  // one of them holds isLinked — so the button is a property of the *type*, which
  // is what makes it detectable without naming a single field.
  //
  // This is why widgets need no special case. A widget prefixes some of these
  // controls with an underscore (`_padding` where a container has `padding`), and
  // a name-based rule would need that mapping; a type-based one never sees it.
  const LINKED_TYPES = new Set(["dimensions", "gaps"]);

  // padding, margin and the container's gap, at every breakpoint — the trailing
  // group is the responsive suffix (padding_tablet, flex_gap_mobile_extra…).
  const BOX_CONTROL = /^(padding|margin|flex_gap|gap)(_[a-z_]+)?$/;

  // Read off the element's own live control list, never a hardcoded table. Two
  // things make that necessary rather than tidy:
  //
  //  - The responsive suffixes depend on which breakpoints the site has switched
  //    on. This build carries tablet_extra and mobile_extra; a default install
  //    does not. Hardcoding the common four would silently miss the others.
  //  - A container's gap control is `flex_gap` (type "gaps"), while section and
  //    column markup carries a *different* control literally named `gap` — a
  //    select holding "default"/"narrow"/"extended". The type gate is what keeps
  //    that one out: it has no entry in BOX_ZEROS, so it is skipped rather than
  //    written with a dimensions value.
  // Both options in one settings object, deliberately. They overlap — padding is
  // a box control *and* a link-bearing one — and a control is a single value, so
  // two commands would mean the second overwriting the first's work on the shared
  // keys. One merged write is also one undo step instead of two.
  const createSettings = (container, { zero, unlink }) => {
    const controls = container?.settings?.controls || {};
    const live = (key) => container?.settings?.get?.(key);
    const settings = {};
    let zeroed = 0;
    let unlinked = 0;

    for (const [key, def] of Object.entries(controls)) {
      const type = def?.type;

      // The zeroing keeps its own narrower scope: the box controls only.
      if (zero && BOX_CONTROL.test(key) && BOX_ZEROS[type]) {
        settings[key] = {
          ...BOX_ZEROS[type],
          // Carried, not asserted. With the unlink option off, zeroing a box must
          // leave the link button exactly where the user left it.
          isLinked: live(key)?.isLinked ?? def?.default?.isLinked ?? true,
        };
        zeroed += 1;
      }

      if (!unlink || !LINKED_TYPES.has(type)) continue;

      // Whatever this run has already decided for the key, else the control's
      // own current value — so a control the reset is not touching keeps its
      // values and only the flag moves.
      const value = settings[key] ?? live(key) ?? def?.default;
      if (!value || typeof value !== "object") continue;
      // Already unlinked and nothing else to write: leave the key out entirely
      // rather than restating a value the element already holds.
      if (value.isLinked === false && !settings[key]) continue;
      settings[key] = { ...value, isLinked: false };
      unlinked += 1;
    }

    return { settings, zeroed, unlinked };
  };

  // What to call the element in the log. A fresh one has no _title, and "widget"
  // alone does not say which — the widgetType is the useful half.
  const elementKind = (container) =>
    container?.model?.get?.("widgetType") ||
    container?.model?.get?.("elType") ||
    "element";

  const applyPureReset = async (id, flags) => {
    let container;
    try {
      container = getContainer(id);
    } catch (_) {
      // Deleted again before the deferred write landed. Nothing was reset, but
      // there is also no element left for that to be wrong about, so this is the
      // one outcome that goes unreported.
      return;
    }
    const kind = elementKind(container);
    const title = containerTitle(container);
    const { settings, zeroed, unlinked } = createSettings(container, flags);
    if (!Object.keys(settings).length) {
      emit("pure-reset", { id, title, kind, zeroed: 0, unlinked: 0 });
      return;
    }
    try {
      // Default render: these controls carry selectors, so the model change
      // alone would leave the preview showing the old box. options.external
      // stays off, for the reason documented on rename.
      await runCommand("document/elements/settings", {
        containers: [container],
        settings,
      });
    } catch (err) {
      emit("pure-reset", {
        id,
        title,
        kind,
        error: String(err?.message || err),
      });
      return;
    }
    emit("pure-reset", { id, title, kind, zeroed, unlinked });
  };

  const elTypeOf = (model) =>
    typeof model?.get === "function" ? model.get("elType") : model?.elType;

  // Which of the two options apply to the element being created. Read in
  // getConditions and again in apply, from the model rather than from a live
  // lookup — at getConditions time the element does not exist yet.
  const hookFlagsFor = (model) => {
    const zero = pureResetEnabled && elTypeOf(model) === "container";
    const unlink = unlinkNewEnabled;
    return { zero, unlink, any: zero || unlink };
  };

  const registerPureResetHook = () => {
    if (pureResetHook) return false;
    const After = window.$e?.modules?.hookData?.After;
    if (
      typeof After !== "function" ||
      typeof window.$e?.hooks?.registerDataAfter !== "function"
    ) {
      pureResetError = "$e.hooks data-after API is unavailable";
      return false;
    }

    class PureContainerReset extends After {
      getCommand() {
        return "document/elements/create";
      }
      getId() {
        return "elementor-tools-pure-container-reset--document/elements/create";
      }
      getConditions(args) {
        if (pureResetSuppressed > 0) return false;
        // Two independent options ride this one hook, with different scopes: the
        // zeroing is about a container's box and applies to containers only,
        // while the unlink is about a button every element type has. Either one
        // being applicable is reason enough to fire.
        if (!hookFlagsFor(args?.model).any) return false;
        // Nested containers need no special case: each one is its own create,
        // so each gets its own hook fire.
        const trace = window.$e?.commands?.currentTrace || [];
        return !trace.some((cmd) => COPY_COMMANDS.has(cmd));
      }
      apply(args, result) {
        const ids = createdIds(result);
        if (!ids.length) return;
        const flags = hookFlagsFor(args?.model);
        // The decision is made above, synchronously, while the trace still says
        // how this container came to exist. Only the *write* is deferred, and it
        // has to be: running a settings command inline would fire while
        // Elementor is still finishing the create it is reporting. By the time
        // this callback runs currentTrace is empty, which is why the copy test
        // cannot be moved down here.
        //
        // It therefore lands as its own undo step. That is accepted rather than
        // worked around — grouping it with the create would mean holding a
        // history log open across a deferral.
        for (const id of ids) {
          setTimeout(() => {
            applyPureReset(id, flags).catch(() => {});
          }, 0);
        }
      }
    }

    try {
      pureResetHook = new PureContainerReset();
      window.$e.hooks.registerDataAfter(pureResetHook);
      pureResetError = null;
      return true;
    } catch (err) {
      pureResetHook = null;
      pureResetError = String(err?.message || err);
      return false;
    }
  };

  const handlers = {
    ping: () => ({ ready: !!(window.$e && window.elementor) }),
    // The panel's two create-hook checkboxes, pushed in together — one hook
    // serves both, so one op configures both. The hook is attached on first
    // contact and then left in place: its own getConditions reads these flags, so
    // toggling an option costs nothing and cannot leave a half-removed hook
    // behind. It stays attached when both go off, because getConditions then
    // refuses everything anyway.
    "configure-pure-reset": async ({ enabled, unlinkNew }) => {
      pureResetEnabled = !!enabled;
      unlinkNewEnabled = !!unlinkNew;
      const wanted = pureResetEnabled || unlinkNewEnabled;
      const justRegistered = wanted ? registerPureResetHook() : false;
      return {
        enabled: pureResetEnabled,
        unlinkNew: unlinkNewEnabled,
        registered: !!pureResetHook,
        justRegistered,
        registerError: pureResetError,
      };
    },
    copy: async ({ id }) => {
      await runCommand("document/elements/copy", {
        containers: [getContainer(id)],
      });
      return {};
    },
    "paste-style": async ({ ids }) => {
      await runCommand("document/elements/paste-style", {
        containers: ids.map(getContainer),
      });
      return {};
    },
    // The whole copy → paste-style loop for a batch of pairs, page-side. Driven
    // a pair at a time from the content script this cost two postMessage round
    // trips per node, and a sync over a large page is thousands of nodes — the
    // messaging, not the Elementor commands, dominated the run. Same commands in
    // the same order with the same clipboard semantics; only the hops are gone.
    //
    // targetIds is a list because one template root routinely styles several page
    // containers: paste-style takes every one of them in a single command, so a
    // source node is copied once instead of once per target. That grouping is
    // what replace-styles.js has always done in its deep mode.
    //
    // A failing pair is recorded and the batch carries on, exactly as the
    // per-pair loop did — one unstylable node must not abandon the rest of the
    // block. Nothing here is retryable by the caller: see REPLAYABLE_OPS.
    "apply-style-pairs": async ({ pairs }) => {
      const list = Array.isArray(pairs) ? pairs : [];
      let done = 0;
      const failures = [];
      for (const pair of list) {
        const targetIds =
          Array.isArray(pair?.targetIds) && pair.targetIds.length
            ? pair.targetIds
            : pair?.targetId
              ? [pair.targetId]
              : [];
        if (!pair?.sourceId || !targetIds.length) continue;
        try {
          await runCommand("document/elements/copy", {
            containers: [getContainer(pair.sourceId)],
          });
          await runCommand("document/elements/paste-style", {
            containers: targetIds.map(getContainer),
          });
          done += targetIds.length;
        } catch (err) {
          failures.push(
            `${pair.sourceId} → ${targetIds.join(", ")}: ${String(
              err?.message || err,
            )}`,
          );
        }
      }
      return { done, failures };
    },
    paste: async ({ targetId, at }) => {
      const result = await runCommand("document/elements/paste", {
        containers: [getContainer(targetId)],
        options: typeof at === "number" ? { at } : {},
      });
      let created = null;
      if (Array.isArray(result)) {
        const flat = result.flat(Infinity);
        created = flat.find((c) => c && c.id);
      } else if (result && result.id) {
        created = result;
      }
      if (!created?.id) throw new Error("paste returned no container id");
      return { id: created.id };
    },
    // Swap a page container for a copy of another container, in place.
    // Done page-side so the parent lookup, index, paste and delete happen
    // without round trips that could interleave with other edits.
    // sourceIds lets a multi-root template drop all of its roots into the one
    // slot, in order. sourceId stays supported for existing callers.
    "replace-container": async ({ sourceId, sourceIds, targetId }) => {
      const ids =
        Array.isArray(sourceIds) && sourceIds.length ? sourceIds : [sourceId];
      const sources = ids.map(getContainer);
      const target = getContainer(targetId);
      const parent = target.parent;
      if (!parent) throw new Error("target container has no parent");
      const index = indexInParent(target, parent);
      if (index < 0) {
        throw new Error("target not found among its parent's children");
      }

      await runCommand("document/elements/copy", { containers: sources });
      const result = await runCommand("document/elements/paste", {
        containers: [parent],
        options: { at: index },
      });
      const created = createdIds(result, target.id);
      if (!created.length) throw new Error("paste returned no new container");

      await runCommand("document/elements/delete", { containers: [target] });
      return { id: created[0], ids: created };
    },
    delete: async ({ ids }) => {
      await runCommand("document/elements/delete", {
        containers: ids.map(getContainer),
      });
      return {};
    },
    // Set the navigator label (settings._title) through Elementor's own settings
    // command, so the rename lands in the undo log and the navigator re-renders
    // itself. batch-rename.js drives the navigator DOM instead, which requires
    // the navigator to be open; this does not.
    // Two shapes: { ids, title } names a batch the same thing in one command;
    // { items: [{ id, title }] } names each element separately, for callers
    // whose names are derived per element. Name formatting stays in the content
    // script (template-format.js) — the page world cannot read that global, and
    // duplicating the tag regex here is how the two would drift.
    rename: async ({ ids, title, items }) => {
      const list = Array.isArray(items)
        ? items
        : (ids || []).map((id) => ({ id, title }));

      // Group equal names so the common case is still one command, and drop
      // no-op renames outright — re-running a sync over an already-tagged page
      // should not touch the document at all.
      const byTitle = new Map();
      const unchanged = [];
      for (const it of list) {
        const name = String(it.title ?? "").trim();
        const container = getContainer(it.id);
        if (containerTitle(container) === name) {
          unchanged.push(it.id);
          continue;
        }
        if (!byTitle.has(name)) byTitle.set(name, []);
        byTitle.get(name).push(container);
      }
      for (const [name, containers] of byTitle) {
        // NEVER pass options.external here. It marks the change as coming from
        // outside the panel, which makes Elementor re-render the element — and
        // re-rendering a live, populated container in the preview is what made a
        // styled container vanish from the page. _title carries no selectors, so
        // the model change on its own is all the navigator needs to relabel.
        await runCommand("document/elements/settings", {
          containers,
          settings: { _title: name },
          options: { render: false },
        });
      }
      return {
        renamed: [...byTitle.values()].flat().map((c) => c.id),
        unchanged,
      };
    },
    // Write one element's Advanced tab (as captured by advancedSettings) onto
    // the elements that replaced it. template-decouple is the caller: the
    // Template widget it swaps out carries its own padding, CSS classes, motion
    // effects and so on, and none of that is in the template's content.
    //
    // Widgets prefix their advanced controls with an underscore and containers
    // mostly do not — _padding vs padding — so each key is resolved against the
    // TARGET's own control list. Two things about that lookup matter:
    //
    //  - It spans every tab, not just the target's advanced one. A widget's
    //    _background_* sits under Advanced while a container's background_*
    //    sits under Style, and filtering the target by tab loses ~245 keys that
    //    map perfectly well.
    //  - It reads the live schema instead of consulting a hand-written mapping
    //    table, which is what keeps it standing up across Elementor versions.
    //
    // A key that resolves to a control of a different type is dropped: same
    // name, different value shape, and writing it would put garbage in the
    // model. Measured against Elementor 4.2.1, 499 of a Template widget's 553
    // advanced controls resolve onto a container with zero type mismatches; the
    // rest (mask, _element_width and friends) genuinely have no container twin,
    // so they come back in `dropped` for the caller to report.
    "apply-advanced-settings": async ({ items }) => {
      const list = Array.isArray(items) ? items : [];
      const results = [];
      for (const item of list) {
        const target = getContainer(item.id);
        const controls = target.settings?.controls || {};
        const settings = {};
        const applied = [];
        const dropped = [];
        for (const entry of item.settings || []) {
          const key = entry?.key;
          if (!key) continue;
          const mapped = resolveControlKey(controls, key);
          if (!mapped) {
            dropped.push({ key, why: "no matching control on the target" });
            continue;
          }
          const targetType = controls[mapped]?.type;
          if (entry.type && targetType && targetType !== entry.type) {
            dropped.push({
              key,
              why: `type mismatch (${entry.type} vs ${targetType})`,
            });
            continue;
          }
          settings[mapped] = entry.value;
          applied.push(mapped);
        }
        // Unlike rename, these controls carry selectors, so the model change on
        // its own would leave the preview stale — the default render is wanted
        // here. options.external still stays off, for the reason on rename.
        if (applied.length) {
          await runCommand("document/elements/settings", {
            containers: [target],
            settings,
          });
        }
        results.push({ id: item.id, applied, dropped });
      }
      return { results };
    },
    // Read one element's Motion Effects tab back out, in the canonical
    // (container) spelling a preset file uses — the exact inverse of
    // apply-preset-settings, and what lets the panel's New button capture a
    // preset from an element the user already styled in Elementor's own UI.
    //
    // Every requested key is answered, default-valued ones included: a preset
    // describes the whole tab, so a captured one has to say what the tab was,
    // not only where it differed. `keys` is the caller's canonical list rather
    // than a section walk, so the page world never has to know which of
    // section_effects' controls are settings.
    "read-preset-settings": async ({ id, keys }) => {
      const target = getContainer(id);
      const controls = target.settings?.controls || {};
      const current = target.settings?.toJSON?.() || {};
      const defaults = target.settings?.defaults || {};
      const values = [];
      const missing = [];
      for (const key of Array.isArray(keys) ? keys : []) {
        const mapped = resolveControlKey(controls, key);
        if (!mapped) {
          missing.push(key);
          continue;
        }
        values.push({
          key,
          value:
            current[mapped] !== undefined ? current[mapped] : defaults[mapped],
        });
      }
      return {
        id,
        title: containerTitle(target),
        elType: target.model?.get?.("elType") || null,
        widgetType: target.model?.get?.("widgetType") || null,
        values,
        missing,
      };
    },
    // Put a whole tab back to its defaults and then write a preset over it, per
    // element. animation-presets.js is the caller: "apply this preset" means the
    // Motion Effects tab now *equals* the preset, so a field the preset omits has
    // to go back to default rather than keep whatever the last preset left there.
    //
    // The reset is document/elements/reset-settings — a real Elementor command,
    // so it lands in history and undoes with the write as one step. Doing it as
    // 61 default-valued writes would work too; this is one command instead.
    //
    // Reset misses are silent, set misses are reported. A key that resolves to
    // nothing has nothing to reset, which is not news; a *value* that could not
    // be written is the caller's warning to raise.
    "apply-preset-settings": async ({ items }) => {
      const list = Array.isArray(items) ? items : [];
      const results = [];
      for (const item of list) {
        const target = getContainer(item.id);
        const controls = target.settings?.controls || {};

        const resetKeys = [];
        for (const key of item.reset || []) {
          const mapped = resolveControlKey(controls, key);
          if (mapped) resetKeys.push(mapped);
        }

        const settings = {};
        const applied = [];
        const skipped = [];
        for (const entry of item.settings || []) {
          const mapped = resolveControlKey(controls, entry?.key);
          if (!mapped) {
            skipped.push({
              key: entry?.key,
              why: "no such control on this element",
            });
            continue;
          }
          const targetType = controls[mapped]?.type;
          if (entry.type && targetType && targetType !== entry.type) {
            skipped.push({
              key: entry.key,
              why: `type mismatch (${entry.type} vs ${targetType})`,
            });
            continue;
          }
          settings[mapped] = entry.value;
          applied.push(mapped);
        }

        if (resetKeys.length) {
          await runCommand("document/elements/reset-settings", {
            containers: [target],
            settings: resetKeys,
          });
        }
        // These controls carry selectors, so the model change alone would leave
        // the preview stale — the default render is wanted. options.external
        // still stays off, for the reason documented on rename.
        if (applied.length) {
          await runCommand("document/elements/settings", {
            containers: [target],
            settings,
          });
        }
        results.push({
          id: item.id,
          title: containerTitle(target),
          reset: resetKeys.length,
          applied,
          skipped,
        });
      }
      return { results };
    },
    // Warm templateContentCache for a whole batch, several requests in flight at
    // once. This is the only part of a batch insert that can genuinely overlap:
    // the imports that follow share one clipboard and one document, so they stay
    // serial, but their network waits do not have to.
    //
    // Every failure is reported rather than thrown — a template that could not be
    // preloaded is simply fetched again by its own insert, so the batch carries on.
    "prefetch-templates": async ({ items, concurrency = 3 }) => {
      const list = Array.isArray(items) ? items : [];
      const loaded = [];
      const failed = [];
      let next = 0;
      const worker = async () => {
        while (next < list.length) {
          const it = list[next++];
          try {
            await getTemplateData(
              it.source || "local",
              it.templateId,
              !!it.withPageSettings,
            );
            loaded.push(String(it.templateId));
          } catch (err) {
            failed.push({
              templateId: String(it.templateId),
              error: String(err?.message || err),
            });
          }
        }
      };
      const lanes = Math.max(
        1,
        Math.min(Number(concurrency) || 1, list.length),
      );
      await Promise.all(Array.from({ length: lanes }, worker));
      return { loaded, failed };
    },
    // Build one element from scratch — no template JSON, no import, no network.
    // The Template widget's whole identity is settings.template_id (the same
    // field list-template-widgets reads), so pointing a fresh one at a template
    // is a create with that single setting: none of insert-template's fetch,
    // clone and id-regeneration work applies, because nothing is being copied.
    //
    // Placement matches insert-template — intoId appends inside that container,
    // afterId lands directly after that element, neither means the end of the
    // page. create takes options.at directly, so unlike import there is no
    // copy → paste → delete shuffle to reach a non-tail index.
    //
    // edit:false because a batch would otherwise open the panel once per element
    // and leave the last one selected, which is not what a batch insert means.
    "create-element": async ({
      elType,
      widgetType,
      settings,
      intoId,
      afterId,
    }) => {
      if (!elType) throw new Error("elType is required");
      if (elType === "widget") {
        if (!widgetType) throw new Error("widgetType is required for a widget");
        // An unregistered widget type still creates an element — it just renders
        // as nothing. "template" ships with Elementor Pro, so a site without Pro
        // would silently collect empty layers; say so instead. An absent cache is
        // not evidence of anything, so it is only consulted when present.
        const cache = window.elementor?.widgetsCache;
        if (cache && !cache[widgetType]) {
          throw new Error(
            `Unknown widget type "${widgetType}" — is Elementor Pro active?`,
          );
        }
      }

      let container;
      let at;
      if (afterId) {
        const anchor = getContainer(afterId);
        container = anchor.parent;
        if (!container) throw new Error("anchor element has no parent");
        const index = indexInParent(anchor, container);
        if (index < 0) {
          throw new Error("anchor not found among its siblings");
        }
        at = index + 1;
      } else {
        container = intoId
          ? getContainer(intoId)
          : window.elementor.getPreviewContainer();
      }
      // Only the document root has no parent, and it takes containers only.
      // Creating a widget there yields a layer nothing can hold, so refuse
      // rather than leaving one behind for the caller to find later.
      if (elType === "widget" && !container.parent) {
        throw new Error(
          "a widget cannot be a direct child of the document — pass intoId or afterId",
        );
      }

      const model = { elType };
      if (widgetType) model.widgetType = widgetType;
      if (settings) model.settings = settings;

      // Held out of Pure Container Reset: this is the extension creating a
      // container, not the user, and the one caller wants a plain wrapper. The
      // hook decides synchronously inside the command, so the counter only has
      // to span the run itself.
      pureResetSuppressed++;
      let result;
      try {
        result = await runCommand("document/elements/create", {
          container,
          model,
          options: { edit: false, ...(typeof at === "number" ? { at } : {}) },
        });
      } finally {
        pureResetSuppressed--;
      }
      const [id] = createdIds(result);
      if (!id) throw new Error("create returned no container id");
      return { id };
    },
    // Placement is optional and defaults to the end of the page, which is what
    // this op has always done. intoId appends inside that container; afterId
    // drops the template in directly after that element. The parent for the
    // afterId case comes off the anchor itself rather than a second id round
    // trip — a top-level element's parent is the document container, which
    // getContainer cannot resolve.
    "insert-template": async ({
      templateId,
      source = "local",
      title = String(templateId),
      type,
      withPageSettings = false,
      intoId,
      afterId,
    }) => {
      if (!window.Backbone) {
        throw new Error("Backbone is unavailable");
      }
      let container;
      let at = null;
      if (afterId) {
        const anchor = getContainer(afterId);
        container = anchor.parent;
        if (!container) throw new Error("selected element has no parent");
        const index = indexInParent(anchor, container);
        if (index < 0) {
          throw new Error("selected element not found among its siblings");
        }
        at = index + 1;
      } else {
        container = intoId
          ? getContainer(intoId)
          : window.elementor.getPreviewContainer();
      }
      const countBefore = childContainers(container).length;

      const model = new window.Backbone.Model({
        template_id: templateId,
        source,
        title,
        type,
      });
      const cached = await getTemplateData(
        source,
        templateId,
        withPageSettings,
      );
      // import can mutate what it is handed — never pass the cached copy itself.
      const data = clone(cached);
      // Every element gets a fresh id before it goes in, so an inserted copy can
      // never collide with something already on the page. See regenerateIds.
      regenerateIds(templateRoots(data), liveIds());
      const jsonRootCount = templateRoots(cached).length;
      const result = await runCommand("document/elements/import", {
        container,
        model,
        data,
        options: { withPageSettings },
      });
      let ids = createdIds(result);
      // import appends, so only a non-tail anchor needs the block moved. at was
      // measured before the import, and appending cannot shift the anchor.
      if (at !== null && at < countBefore && ids.length) {
        ids = await moveToIndex(ids, container, at);
      }
      return { ids, jsonRootCount };
    },
    // What the editor currently has selected, for tools that place content
    // relative to it. elementor.selection is the authority; the panel's edited
    // element and the navigator's editing row cover versions or states where it
    // reports nothing.
    "describe-selection": async () => {
      const sources = [
        [
          "selection",
          () =>
            (window.elementor?.selection?.getElements?.() || [])
              .map((el) => el?.id || el?.model?.get?.("id") || null)
              .filter(Boolean),
        ],
        [
          "panel",
          () => {
            const view = window.elementor
              ?.getPanelView?.()
              ?.getCurrentPageView?.()
              ?.getOption?.("editedElementView");
            const id = view?.container?.id || view?.model?.get?.("id") || null;
            return id ? [id] : [];
          },
        ],
        [
          "navigator",
          () => {
            const row = document.querySelector(
              ".elementor-navigator__item.elementor-editing",
            );
            const id = row
              ?.closest(".elementor-navigator__element[data-id]")
              ?.getAttribute("data-id");
            return id ? [id] : [];
          },
        ],
      ];

      for (const [via, read] of sources) {
        let ids = [];
        try {
          ids = read().map(String);
        } catch (_) {
          continue;
        }
        for (const id of ids) {
          let container = null;
          try {
            container = getContainer(id);
          } catch (_) {
            continue;
          }
          // Only the document root has no parent, and it is not a selection —
          // some versions report it when nothing is really selected.
          if (!container.parent) continue;
          // Elementor can hold several elements selected; the first one is the
          // target and the count lets the caller say so.
          return {
            selected: describeSelected(container, via),
            count: ids.length,
          };
        }
      }
      return { selected: null, count: 0 };
    },
    "describe-tree": async ({ id }) => ({
      tree: describeContainer(getContainer(id)),
    }),
    // Reads the template JSON without importing it — tells apart "the template
    // really has N roots" from "our import produced N".
    "inspect-template": async ({
      templateId,
      source = "local",
      withPageSettings = false,
    }) => {
      const data = await getTemplateData(source, templateId, withPageSettings);
      const roots = templateRoots(data);
      return {
        rootCount: roots.length,
        roots: roots.map((el) => ({
          elType: el?.elType || null,
          widgetType: el?.widgetType || null,
          childCount: Array.isArray(el?.elements) ? el.elements.length : 0,
        })),
        dataKeys:
          data && typeof data === "object" && !Array.isArray(data)
            ? Object.keys(data)
            : `array(${Array.isArray(data) ? data.length : typeof data})`,
      };
    },
    // Every node in the document, flat, in document order. depth 0 is a
    // top-level container, so the caller filters rather than needing a
    // second op for the shallow case.
    // Every Elementor Pro Template widget in the document, wherever it sits.
    // Separate from list-containers because the things that matter here live in
    // settings — template_id, and the widget's own Advanced tab — which no other
    // op reads. The model stores template_id as a string; it is normalised to
    // one so callers can key on it safely.
    "list-template-widgets": async () => {
      if (typeof window.elementor?.getPreviewContainer !== "function") {
        throw new Error("elementor.getPreviewContainer is unavailable");
      }
      const widgets = [];
      const walk = (container, path) => {
        childContainers(container).forEach((child, index) => {
          const elType = child.model?.get?.("elType") || null;
          const widgetType = child.model?.get?.("widgetType") || null;
          const step = `${path} > [${index}]${elType || "?"}${
            widgetType ? `:${widgetType}` : ""
          }`;
          if (widgetType === "template") {
            const raw = child.settings?.get?.("template_id");
            widgets.push({
              id: child.id,
              // "" and undefined both mean "points at nothing" — one null.
              templateId:
                raw === undefined || raw === null || raw === ""
                  ? null
                  : String(raw),
              title: containerTitle(child),
              // Captured here, at scan time, because replace-container deletes
              // the widget — by the time there is somewhere to put these the
              // element that holds them is gone. The default-diff keeps it to
              // the handful of controls actually set, so carrying it on every
              // scan costs next to nothing.
              advanced: advancedSettings(child),
              parentId: container.id,
              parentTitle: containerTitle(container),
              index,
              path: step,
            });
          }
          walk(child, step);
        });
      };
      walk(window.elementor.getPreviewContainer(), "root");
      return { widgets };
    },
    "list-containers": async () => {
      if (typeof window.elementor?.getPreviewContainer !== "function") {
        throw new Error("elementor.getPreviewContainer is unavailable");
      }
      const root = window.elementor.getPreviewContainer();
      const out = [];
      const walk = (container, parentId, depth) => {
        for (const c of childContainers(container)) {
          out.push({
            id: c.id,
            title: containerTitle(c),
            elType: c.model?.get?.("elType") || null,
            widgetType: c.model?.get?.("widgetType") || null,
            parentId,
            depth,
          });
          walk(c, c.id, depth + 1);
        }
      };
      walk(root, null, 0);
      return { containers: out };
    },
    // Collapses the whole sync (potentially hundreds of $e.run calls) into a
    // single undo step. Non-fatal: a null logId just means no grouping.
    "history-start": async ({ title }) => {
      try {
        const logId = window.$e?.internal?.("document/history/start-log", {
          type: "change",
          title: title || "Sync template styles",
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
    "list-templates": async ({ source = "local" } = {}) => {
      if (!window.wpApiSettings?.nonce) {
        throw new Error("wpApiSettings.nonce is unavailable");
      }
      const res = await fetch(
        `/wp-json/elementor/v1/template-library/templates?source=${encodeURIComponent(source)}`,
        {
          credentials: "same-origin",
          headers: { "X-WP-Nonce": window.wpApiSettings.nonce },
        },
      );
      if (!res.ok) {
        throw new Error(`Templates request failed: ${res.status}`);
      }
      const json = await res.json();
      if (json.code) {
        throw new Error(json.message || json.code);
      }
      const raw = json.templates || json;
      const list = Array.isArray(raw) ? raw : Object.values(raw || {});
      // Field names vary across Elementor versions, so take the first of
      // several candidates and return the raw key list for diagnosis.
      //
      // This mapping is duplicated as normalizeTemplateList in
      // template-format.js, which Tools/admin-templates.js uses to answer the
      // same request from wp-admin. It has to be: this file is injected into
      // the page world and cannot read a content-script global — the same
      // boundary that keeps the template-tag regex out of here. Change one,
      // change both.
      const templates = list.map((t) => ({
        templateId: t.template_id,
        title: t.title,
        type: t.type,
        source: t.source || source,
        author: t.author || t.user || null,
        date: t.date ?? null,
        modified: t.modified ?? t.post_modified ?? null,
        humanDate: t.human_date || null,
        humanModified:
          t.human_modified_date ||
          t.humanModifiedDate ||
          t.modified_date ||
          null,
        // The library hands back the template's own public permalink
        // ("/?elementor_library=<slug>"). It is the panel's View link, and it
        // beats deriving one from the title — a slug is not a slugified title
        // once WordPress has deduplicated it.
        url: t.url || null,
        status: t.status || null,
      }));
      return { templates, fields: list.length ? Object.keys(list[0]) : [] };
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
