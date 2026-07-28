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

  const getTemplateData = async (source, templateId, withPageSettings) => {
    if (!window.elementor?.templates?.requestTemplateContent) {
      throw new Error("elementor.templates.requestTemplateContent is unavailable");
    }
    const cacheKey = `${source}:${templateId}:${withPageSettings ? 1 : 0}`;
    let cached = templateContentCache.get(cacheKey);
    if (!cached) {
      cached = await window.elementor.templates.requestTemplateContent(
        source,
        templateId,
        { data: { with_page_settings: withPageSettings } },
      );
      templateContentCache.set(cacheKey, cached);
    }
    return cached;
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

  const handlers = {
    ping: () => ({ ready: !!(window.$e && window.elementor) }),
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
      const cached = await getTemplateData(source, templateId, withPageSettings);
      // import remaps ids and can mutate what it is handed — never pass the
      // cached copy itself.
      const data = clone(cached);
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
    "describe-tree": async ({ id }) => ({ tree: describeContainer(getContainer(id)) }),
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
    // Separate from list-containers because the thing that matters here lives
    // in settings.template_id, which no other op reads. The model stores it as
    // a string; it is normalised to one so callers can key on it safely.
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
          t.human_modified_date || t.humanModifiedDate || t.modified_date || null,
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
