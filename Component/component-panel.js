// Component system — the command centre window.
//
// The in-editor overlay answers "what is in front of me". This answers "what is
// on this site": every base, with its instances beneath it and their instances
// beneath them, wherever they live.
//
// Its own window rather than a view inside UI/panel.html, so the rule that
// deleting Component/ removes the feature outright still holds. The cost is
// that askElementorTab and openInNewTab are re-implemented here rather than
// imported — UI/panel.js is a script, not a module, and nothing in it is
// reachable from another page. Both are marked MIRROR; change one, change both.
//
// Reads two globals its HTML loads: __ElementorTemplateFormat for the editor
// URL and the search predicate, __ElementorComponentFormat for the tree and the
// icons. Neither is modified.
(() => {
  const fmt = window.__ElementorComponentFormat;
  const tf = window.__ElementorTemplateFormat;

  const CACHE_KEY = "componentIndex";
  // How many documents' content are asked for per message. The content script
  // batches internally too; this outer chunk exists only so the status line can
  // move — one message covering 400 documents would sit silent for minutes and
  // read as a hang.
  const READ_CHUNK = 30;

  const $ = (id) => document.getElementById(id);
  const searchEl = $("search");
  const statusEl = $("status");
  const treeEl = $("tree");
  const footEl = $("foot");
  const refreshBtn = $("refresh");

  let cache = null; // { version, origin, scannedAt, docs: { id: doc } }
  let workingDomain = "";
  let openPostId = null; // which document an editor tab currently has open
  let filter = "all";
  let busy = false;
  let lastWarnings = [];
  const collapsed = new Set();

  const setStatus = (text, tone = "") => {
    statusEl.textContent = text;
    statusEl.className = `status${tone ? ` ${tone}` : ""}`;
  };

  const setBusy = (on) => {
    busy = on;
    refreshBtn.disabled = on;
    refreshBtn.textContent = on ? "Scanning…" : "Refresh";
  };

  /* ------------------------------------------------------------- MIRROR block

     Both of these are copies of UI/panel.js. See the file header for why they
     cannot be shared. */

  // One ranking across both kinds of tab — origin, then active, then editor.
  // Grouping editors ahead of admin tabs was a real bug there: a background
  // editor on any site outranked the wp-admin tab in front of the user.
  const askTab = async (message, { preferOrigin = "" } = {}) => {
    const tabs = await browser.tabs.query({});
    const urlOf = (t) => t.url || "";
    const editors = tabs.filter((t) => urlOf(t).includes("action=elementor"));
    const admins = tabs.filter(
      (t) => !editors.includes(t) && urlOf(t).includes("/wp-admin/"),
    );
    const matchesOrigin = (t) =>
      !!preferOrigin && urlOf(t).startsWith(`${preferOrigin}/`);
    const score = (t) =>
      (matchesOrigin(t) ? 4 : 0) + (t.active ? 2 : 0) + (editors.includes(t) ? 1 : 0);
    const known = [...editors, ...admins];
    const candidates = (known.length ? known : tabs.slice()).sort(
      (a, b) => score(b) - score(a),
    );
    for (const tab of candidates) {
      try {
        const reply = await browser.tabs.sendMessage(tab.id, message);
        if (reply) return { tab, reply };
      } catch (_) {
        // No listener in that tab — expected for most of them.
      }
    }
    return { tab: null, reply: null };
  };

  // This window is a popup and cannot hold tabs, so the target window has to be
  // named rather than defaulted.
  const openInNewTab = async (url) => {
    const wins = await browser.windows.getAll({});
    const normal = wins.filter((w) => w.type === "normal");
    const target = normal.find((w) => w.focused) || normal[0];
    if (target) {
      await browser.tabs.create({ url, windowId: target.id, active: true });
      await browser.windows.update(target.id, { focused: true });
      return;
    }
    await browser.windows.create({ url });
  };

  const preferOrigin = () => tf.parseWorkingDomain(workingDomain)?.origin || "";

  /* -------------------------------------------------------------------- scan */

  // Cache-and-diff. The cheap pass lists every Elementor document with its
  // modified_gmt; only documents whose stamp moved get their _elementor_data
  // read, which is the difference between minutes and seconds on every run
  // after the first.
  //
  // Documents with NO components are cached too, deliberately. Without an entry
  // they would look unread on every refresh and be re-fetched forever — and
  // they are the majority of any real site.
  const scan = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setStatus("Asking a WordPress tab for the document list…");
      const { tab, reply } = await askTab(
        { __elementorComponents: true, type: "index-list-docs" },
        { preferOrigin: preferOrigin() },
      );
      if (!reply) {
        setStatus(
          "No Elementor editor or WordPress admin tab open — open one, then Refresh.",
          "error",
        );
        return;
      }
      if (!reply.ok) {
        setStatus(`Could not list documents — ${reply.error}`, "error");
        return;
      }

      const docs = reply.docs || [];
      const origin = reply.origin || "";
      // A cache from another site describes nothing about this one. Same
      // reasoning as preferring an origin-matched tab.
      const reusable =
        cache && cache.version === fmt.INDEX_VERSION && cache.origin === origin
          ? cache.docs || {}
          : {};

      // Two stamps per document, and the split is load-bearing:
      //
      //   modifiedGmt  what the document says right now. Feeds the staleness
      //                comparison, so it must always be the truth.
      //   indexedGmt   what it said the last time its content was successfully
      //                READ. Feeds the diff.
      //
      // One field cannot do both. Storing the fresh stamp against a document
      // whose read failed would make the next refresh consider it up to date
      // and never retry it — its components would silently vanish from the tree
      // and stay gone, which is the worst failure this cache could have.
      const next = {};
      const stale = [];
      for (const doc of docs) {
        const prev = reusable[doc.id];
        if (prev && prev.indexedGmt && prev.indexedGmt === doc.modifiedGmt) {
          // Unchanged: keep the components already extracted, but take the
          // freshly-listed metadata — a retitled or republished document has
          // the same content and a different label.
          next[doc.id] = {
            ...doc,
            components: prev.components || [],
            indexedGmt: prev.indexedGmt,
          };
        } else {
          next[doc.id] = { ...doc, components: [], indexedGmt: null };
          stale.push(doc);
        }
      }

      const kept = docs.length - stale.length;
      if (!stale.length) {
        setStatus(`Nothing changed — ${docs.length} document(s) already indexed.`, "ok");
      }

      const warnings = [...(reply.warnings || [])];
      for (let i = 0; i < stale.length; i += READ_CHUNK) {
        const slice = stale.slice(i, i + READ_CHUNK);
        setStatus(
          `Reading document ${i + 1}–${Math.min(i + READ_CHUNK, stale.length)} ` +
            `of ${stale.length}${kept ? ` (${kept} unchanged)` : ""}…`,
        );
        const res = await browser.tabs
          .sendMessage(tab.id, {
            __elementorComponents: true,
            type: "index-read-docs",
            options: {
              targets: slice.map((d) => ({ id: d.id, restBase: d.restBase })),
            },
          })
          .catch((err) => ({ ok: false, error: String(err?.message || err) }));

        if (!res?.ok) {
          // Keep whatever landed rather than throwing the run away — a
          // half-built index still answers most questions, and the status says
          // it is partial.
          warnings.push(`batch at ${i + 1}: ${res?.error}`);
          continue;
        }
        warnings.push(...(res.warnings || []));
        for (const [id, found] of Object.entries(res.results || {})) {
          if (!next[id]) continue;
          if (found.error) {
            warnings.push(`document ${id}: ${found.error}`);
            continue;
          }
          // indexedGmt is stamped ONLY here, on the success path. Everything
          // that did not reach this line stays unindexed and is retried.
          next[id] = {
            ...next[id],
            components: found.components || [],
            indexedGmt: next[id].modifiedGmt,
          };
          if (found.broken?.length) {
            warnings.push(
              `document ${id}: ${found.broken.length} unreadable component payload(s)`,
            );
          }
        }
      }

      // Anything still unindexed failed to read this run. Restore whatever the
      // previous scan knew about it rather than publishing an empty component
      // list — a failed read is "no information", not "no components".
      let unread = 0;
      for (const doc of stale) {
        const entry = next[doc.id];
        if (entry.indexedGmt) continue;
        unread++;
        const prev = reusable[doc.id];
        entry.components = prev?.components || [];
        entry.indexedGmt = prev?.indexedGmt || null;
      }
      if (unread) {
        warnings.push(
          `${unread} document(s) could not be read — they will be retried on the next Refresh`,
        );
      }

      cache = {
        version: fmt.INDEX_VERSION,
        origin,
        scannedAt: Date.now(),
        docs: next,
      };
      await browser.storage.local.set({ [CACHE_KEY]: cache });

      if (stale.length) {
        const total = Object.values(next).reduce(
          (n, d) => n + (d.components || []).length,
          0,
        );
        setStatus(
          `Indexed ${docs.length} document(s), ${total} component(s)` +
            `${kept ? `, ${kept} unchanged` : ""}` +
            `${warnings.length ? ` · ${warnings.length} warning(s)` : ""}` +
            ` · via ${tab.url?.includes("action=elementor") ? "editor" : "wp-admin"}`,
          warnings.length ? "warn" : "ok",
        );
      }
      // Surfaced rather than swallowed: a post type the account cannot list
      // otherwise reads as "that type holds no components". Held in a variable
      // because render() owns the footer and would clobber a direct write.
      lastWarnings = warnings;
      render();
    } catch (err) {
      setStatus(`Scan failed — ${err?.message || err}`, "error");
    } finally {
      setBusy(false);
    }
  };

  /* ------------------------------------------------------------------- render */

  const docsArray = () => Object.values(cache?.docs || {});

  const keyOf = (node) =>
    `${node.doc.id}:${node.comp.instanceId || node.comp.id}`;

  const rowMatches = (node, terms) =>
    tf.matchesTerms(
      {
        title: node.comp.name,
        type: node.comp.role,
        extra: `${node.doc.title} ${node.doc.typeLabel} ${node.doc.typeSlug} ${node.doc.status} ${node.doc.id} ${node.state?.state || ""}`,
      },
      terms,
    );

  const needsAttention = (node) =>
    node.state?.state === "broken" || node.state?.state === "stale";

  // A node survives the filter if it matches, or if anything beneath it does —
  // hiding a base because only its instance matched would hide the match.
  const prune = (node, terms) => {
    const kids = node.children
      .map((k) => prune(k, terms))
      .filter(Boolean);
    const selfOk =
      rowMatches(node, terms) &&
      (filter !== "attention" || needsAttention(node)) &&
      (filter !== "bases" || node.comp.role === "base");
    if (!selfOk && !kids.length) return null;
    return { ...node, children: kids, dimmed: !selfOk };
  };

  // Every indexed document is Elementor-built — the cheap pass filters on
  // `elementor === true` — so Edit never has to choose between the Elementor
  // editor and WordPress's, and can never hit the trap the main panel guards
  // against, where post.php?action=elementor quietly converts a post Elementor
  // never built.
  const editUrlFor = (doc) => tf.elementorEditUrl(workingDomain, doc.id);

  // View is the permalink for a published post and the preview route for
  // anything else, exactly as the main panel's content list does it.
  //
  // The one adjustment is templates. elementor_library reports viewable:false
  // from /wp/v2/types, but its permalink ("/?elementor_library=<slug>") renders
  // perfectly well — the same fact the main panel relies on for its Templates
  // tab. So a template with a link is treated as viewable rather than being
  // given a dead button.
  const viewUrlFor = (doc) =>
    tf.contentViewUrl(workingDomain, {
      id: doc.id,
      link: doc.link,
      status: doc.status,
      viewable: doc.isTemplate ? !!doc.link : doc.viewable,
    });

  const renderRow = (node, out) => {
    const row = document.createElement("div");
    row.className = "row";
    row.style.paddingLeft = `${8 + node.depth * 16}px`;
    if (node.dimmed) row.style.opacity = "0.55";

    const key = keyOf(node);
    const hasKids = node.children.length > 0;
    const isCollapsed = collapsed.has(key);

    const twisty = document.createElement("span");
    twisty.className = `twisty${hasKids ? "" : " leaf"}`;
    twisty.textContent = hasKids ? (isCollapsed ? "▸" : "▾") : "·";
    if (hasKids) {
      twisty.addEventListener("click", () => {
        if (collapsed.has(key)) collapsed.delete(key);
        else collapsed.add(key);
        render();
      });
    }

    const icon = document.createElement("span");
    icon.className = `icon tone-${node.icon?.tone || "info"}`;
    icon.textContent = node.icon?.glyph || "•";
    icon.title = node.state?.reason
      ? `${node.icon?.label} — ${node.state.reason}`
      : node.icon?.label || "";

    const body = document.createElement("div");
    body.className = "body";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = node.comp.name || "(unnamed)";
    const badge = document.createElement("span");
    badge.className = `badge${node.comp.role === "base" ? " base" : ""}`;
    badge.textContent = node.comp.role;
    name.appendChild(badge);
    if (hasKids) {
      const count = document.createElement("span");
      count.className = "badge";
      count.textContent = `${node.children.length}`;
      count.title = `${node.children.length} direct instance(s)`;
      name.appendChild(count);
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    const bits = [`in "${node.doc.title || `#${node.doc.id}`}"`, node.doc.typeLabel];
    if (node.doc.status && node.doc.status !== "publish") bits.push(node.doc.status);
    if (node.comp.overrideCount) bits.push(`${node.comp.overrideCount} override(s)`);
    if (node.comp.removedCount) bits.push(`-${node.comp.removedCount} node(s)`);
    if (node.comp.addedCount) bits.push(`+${node.comp.addedCount} node(s)`);
    if (node.state?.reason) bits.push(node.state.reason);
    if (node.cycle) bits.push("chain loops here — not expanded further");
    meta.textContent = bits.join(" · ");

    body.append(name, meta);

    const buttons = document.createElement("div");
    buttons.className = "buttons";

    // Rename is allowed only where the write can actually land. A component in
    // a document no editor has open would be silently reverted by that
    // document's next save — the clobbering documented on out-of-band writes —
    // so the button says why instead of failing quietly.
    const canRename = openPostId && String(node.doc.id) === String(openPostId);
    const renameBtn = document.createElement("button");
    renameBtn.className = "clear";
    renameBtn.textContent = "✎";
    renameBtn.disabled = !canRename;
    renameBtn.title = canRename
      ? "Rename this component"
      : "Open this document in the Elementor editor to rename it here";
    renameBtn.addEventListener("click", () => startRename(node, name, renameBtn));

    const editBtn = document.createElement("button");
    editBtn.className = "clear";
    editBtn.textContent = "Edit";
    const url = editUrlFor(node.doc);
    editBtn.disabled = !url;
    editBtn.title = url
      ? `Open "${node.doc.title}" in the Elementor editor`
      : "Set a Working Domain in the main panel to enable Edit";
    editBtn.addEventListener("click", () => url && openInNewTab(url));

    const viewBtn = document.createElement("button");
    viewBtn.className = "clear";
    viewBtn.textContent = "View";
    const viewUrl = viewUrlFor(node.doc);
    viewBtn.disabled = !viewUrl;
    viewBtn.title = viewUrl
      ? `Open the rendered "${node.doc.title}"`
      : node.doc.viewable === false && !node.doc.link
        ? "This post type cannot be viewed on the front end"
        : "Set a Working Domain in the main panel to enable View";
    viewBtn.addEventListener("click", () => viewUrl && openInNewTab(viewUrl));

    buttons.append(renameBtn, editBtn, viewBtn);
    row.append(twisty, icon, body, buttons);
    out.appendChild(row);

    if (!isCollapsed) for (const kid of node.children) renderRow(kid, out);
  };

  const startRename = (node, nameEl, btn) => {
    if (btn.dataset.editing === "1") return;
    btn.dataset.editing = "1";
    const current = node.comp.name || "";
    nameEl.replaceChildren();

    const input = document.createElement("input");
    input.type = "text";
    input.value = current;
    const stop = () => {
      btn.dataset.editing = "0";
      render();
    };
    const commit = async () => {
      const value = input.value.trim();
      if (!value || value === current) return stop();
      input.disabled = true;
      const { reply } = await askTab(
        {
          __elementorComponents: true,
          type: "rename",
          widgetId: node.comp.widgetId,
          name: value,
        },
        { preferOrigin: preferOrigin() },
      );
      if (!reply?.ok) {
        setStatus(`Rename failed — ${reply?.error || "no editor tab answered"}`, "error");
        stop();
        return;
      }
      // The cached copy is now behind the document. Patch it rather than
      // forcing a full re-scan for one string — the next Refresh re-reads this
      // document anyway, because saving it moves its modified_gmt.
      node.comp.name = value;
      const cached = cache?.docs?.[node.doc.id]?.components || [];
      const hit = cached.find((c) => c.widgetId === node.comp.widgetId);
      if (hit) hit.name = value;
      await browser.storage.local.set({ [CACHE_KEY]: cache });
      setStatus(`Renamed to "${value}".`, "ok");
      stop();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      else if (e.key === "Escape") stop();
    });
    nameEl.appendChild(input);
    input.focus();
    input.select();
  };

  const render = () => {
    treeEl.replaceChildren();

    if (!cache) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.style.padding = "12px 8px";
      empty.textContent =
        "Not scanned yet. Refresh reads every Elementor document on the site once — " +
        "that takes a few minutes on a large site. Afterwards it only re-reads what changed.";
      treeEl.appendChild(empty);
      footEl.textContent = "";
      return;
    }

    const { roots, total } = fmt.buildIndexTree(docsArray());
    const terms = tf.searchTerms(searchEl.value);
    const shown = roots.map((r) => prune(r, terms)).filter(Boolean);

    // Sorted so the things that need doing float up, then alphabetically —
    // a command centre whose first screen is arbitrary is a list, not a centre.
    const rank = (n) =>
      n.state?.state === "broken" ? 0 : n.state?.state === "stale" ? 1 : 2;
    shown.sort(
      (a, b) =>
        rank(a) - rank(b) || String(a.comp.name).localeCompare(String(b.comp.name)),
    );

    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.style.padding = "12px 8px";
      empty.textContent = total
        ? "Nothing matches."
        : "No components found on this site yet.";
      treeEl.appendChild(empty);
    }
    for (const node of shown) renderRow(node, treeEl);

    const count = (nodes) =>
      nodes.reduce((n, x) => n + 1 + count(x.children), 0);
    const when = cache.scannedAt ? new Date(cache.scannedAt).toLocaleString() : "never";
    const docCount = docsArray().length;
    footEl.textContent =
      `${count(shown)} of ${total} component(s) · ${docCount} document(s) indexed · ` +
      `last scan ${when}` +
      (openPostId ? ` · editor has #${openPostId} open` : " · no editor tab open") +
      (lastWarnings.length
        ? `\nWarnings: ${lastWarnings.slice(0, 6).join(" · ")}` +
          (lastWarnings.length > 6 ? ` · +${lastWarnings.length - 6} more` : "")
        : "");
    footEl.style.whiteSpace = "pre-wrap";
  };

  /* -------------------------------------------------------------------- boot */

  // Which document an editor currently has open, so the rename buttons know
  // whether they are allowed to write. Cheap and best-effort: no editor tab is
  // a normal state, not an error.
  const readOpenDoc = async () => {
    const { reply } = await askTab(
      { __elementorComponents: true, type: "doc-info" },
      { preferOrigin: preferOrigin() },
    );
    openPostId = reply?.ok ? reply.postId : null;
  };

  const boot = async () => {
    const state = await browser.storage.local.get([CACHE_KEY, "workingDomain"]);
    workingDomain = state.workingDomain || "";
    const stored = state[CACHE_KEY];
    // A cache written by an older build is discarded rather than migrated:
    // re-earning it costs one Refresh, and rendering a half-understood index
    // would show a wrong tree with no sign that it is wrong.
    cache = stored && stored.version === fmt.INDEX_VERSION ? stored : null;
    render();
    if (cache) {
      setStatus(
        `Showing the last scan. Refresh to pick up changes.`,
        "",
      );
    } else {
      setStatus("Press Refresh to build the index.", "");
    }
    await readOpenDoc();
    render();
  };

  /* ------------------------------------------------- actions on the open doc

     These are the buttons that used to sit in UI/panel.html. They need
     `elementor`, which no extension page has, so each one asks the editor tab
     to run it and reports that the run STARTED — not that it finished. A sync
     draws its own modal and can take a minute; holding the message open would
     time this window out for nothing. Same contract as run-action.

     The responding tab is brought forward afterwards, because this is a popup
     window and the tool's modal would otherwise open somewhere the user is not
     looking. */

  const docStatusEl = $("doc-status");
  const showDocStatus = (text, tone = "") => {
    docStatusEl.textContent = text;
    docStatusEl.className = `status${tone ? ` ${tone}` : ""}`;
  };

  const runInEditor = async (btn, message, label) => {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "…";
    showDocStatus("");
    try {
      const { tab, reply } = await askTab(
        { __elementorComponents: true, ...message },
        { preferOrigin: preferOrigin() },
      );
      if (!reply) {
        showDocStatus("No Elementor editor tab open — open one, then try again.", "warn");
        return;
      }
      if (!reply.ok) {
        showDocStatus(`${label} failed — ${reply.error}`, "error");
        return;
      }
      showDocStatus(`${label} — running in the editor tab`, "ok");
      try {
        await browser.tabs.update(tab.id, { active: true });
        if (tab.windowId !== undefined) {
          await browser.windows.update(tab.windowId, { focused: true });
        }
      } catch (_) {
        // The tab can be gone by now; the run itself already happened.
      }
    } catch (err) {
      showDocStatus(`${label} failed — ${err?.message || err}`, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  };

  const editorAction = (id, message, label) =>
    $(id).addEventListener("click", () => runInEditor($(id), message, label));

  editorAction("a-overlay", { type: "open-ui" }, "In-editor panel");
  editorAction("a-sync", { type: "run", action: "sync" }, "Sync");
  editorAction("a-new", { type: "run", action: "new" }, "New Component");
  editorAction("a-insert", { type: "run", action: "insert" }, "Insert");
  editorAction("a-link", { type: "run", action: "link" }, "Link");
  editorAction("a-reset", { type: "run", action: "reset" }, "Reset to base");
  editorAction("a-detach", { type: "run", action: "detach" }, "Detach");

  refreshBtn.addEventListener("click", async () => {
    await readOpenDoc();
    await scan();
  });
  searchEl.addEventListener("input", render);

  const setFilter = (next) => {
    filter = next;
    for (const [id, value] of [
      ["f-all", "all"],
      ["f-attention", "attention"],
      ["f-bases", "bases"],
    ]) {
      $(id).classList.toggle("on", filter === value);
    }
    render();
  };
  $("f-all").addEventListener("click", () => setFilter("all"));
  $("f-attention").addEventListener("click", () => setFilter("attention"));
  $("f-bases").addEventListener("click", () => setFilter("bases"));
  $("expand").addEventListener("click", () => {
    collapsed.clear();
    render();
  });
  $("collapse").addEventListener("click", () => {
    const { roots } = fmt.buildIndexTree(docsArray());
    const walk = (n) => {
      if (n.children.length) collapsed.add(keyOf(n));
      n.children.forEach(walk);
    };
    roots.forEach(walk);
    render();
  });

  // The Working Domain lives in the main panel and every Edit link is built
  // from it, so a change there has to reach these rows without a reload.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.workingDomain) {
      workingDomain = changes.workingDomain.newValue || "";
      render();
    }
  });

  boot();
})();
