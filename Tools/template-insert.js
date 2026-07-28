(() => {
  if (!location.search.includes("action=elementor")) return;

  const ns = (window.__ElementorTools = window.__ElementorTools || {});

  const MODAL_ID = "ElementorTools-template-insert-modal";

  let running = false;

  const STATE_COLORS = {
    pending: "#888",
    running: "#7a9cff",
    ok: "#6ac47a",
    warn: "#e0b060",
    error: "#e07070",
  };

  const { metaLine, searchTerms, matchesTerms, withTemplateTag } =
    window.__ElementorTemplateFormat;

  const typeOf = (s) =>
    `${s.elType || "?"}${s.widgetType ? `:${s.widgetType}` : ""}`;

  // The bridge keeps waiting past a timeout rather than abandoning the request —
  // an insert that outran its deadline has still landed. Report the wait so the
  // modal doesn't sit on a stale phase looking stuck.
  const waitStatus = (shell) => (info) =>
    shell.setStatus(
      `Still waiting on ${info.op} — ${Math.round(info.waited / 1000)}s so far, not giving up…`,
    );

  const nameOf = (s) => (s.title ? `"${s.title}"` : "(untitled)");

  // What the editor's current selection means for placement. A container takes
  // the templates as its last children; anything else cannot hold children, so
  // they land directly after it instead.
  const placementFor = (selected, count) => {
    const extra =
      count > 1 ? ` · ${count} selected, using the first` : "";
    if (selected.canHoldChildren) {
      return {
        label: `Insert inside selected container ${nameOf(selected)}`,
        hint: `${typeOf(selected)} · templates become its last children${extra}`,
        args: { intoId: selected.id },
        describe: `inside ${nameOf(selected)}`,
      };
    }
    const parent = selected.parentTitle
      ? ` inside "${selected.parentTitle}"`
      : "";
    return {
      label: `Insert after selected layer ${nameOf(selected)}`,
      hint: `${typeOf(selected)}${parent} · not a container, so templates go directly after it${extra}`,
      args: { afterId: selected.id },
      describe: `after ${nameOf(selected)}`,
    };
  };

  const readPlacement = async () => {
    // waitLimit 1. This read gates the picker (it shares a Promise.all with the
    // library fetch), and a failed read is already non-fatal — the option simply
    // isn't offered. Letting it re-arm would hold the picker shut for ten spans
    // while the notice still read "Fetching site templates…", which is the exact
    // stale-phase symptom the wait plumbing exists to prevent.
    const res = await ns.callBridge("describe-selection", {}, { waitLimit: 1 });
    if (!res?.ok) {
      ns.log("warn", `Template insert: no selection read — ${res?.error}`);
      return null;
    }
    if (!res.selected) return null;
    ns.log(
      "info",
      `Template insert: selection ${nameOf(res.selected)} (${typeOf(
        res.selected,
      )}) via ${res.selected.via}`,
    );
    return placementFor(res.selected, res.count);
  };

  // A freshly imported root lands in the navigator as a generic "Container",
  // which is unreadable in a long page — and template-sync finds page blocks by
  // name, so the template's title is exactly the name that keeps the block
  // findable afterwards. The template id is appended as a tag, which is the
  // exact link that survives the name being edited later.
  //
  // The name is always the template's title from the library, whatever the root
  // happened to be called inside the template. With several roots the tag also
  // carries the root's position (#id.1, #id.2), which is what tells them apart —
  // identical names are fine because the tag, not the name, is the identity.
  const nameRoots = async (ids, template) => {
    const list = ids || [];
    const multi = list.length > 1;
    const items = list
      .map((id, i) => ({
        id,
        title: withTemplateTag(
          template.title,
          template.templateId,
          multi ? i + 1 : null,
        ),
      }))
      .filter((it) => it.title);
    if (!items.length) return "";

    const res = await ns.callBridge("rename", { items });
    if (!res?.ok) {
      ns.log("warn", `Template insert: naming roots failed — ${res?.error}`);
      return " · rename failed";
    }
    const names = [...new Set(items.map((it) => it.title))]
      .map((n) => `"${n}"`)
      .join(", ");
    ns.log("info", `Template insert: named ${items.length} root(s) ${names}`);
    return ` · named ${names}`;
  };

  // Title only, no #id tag. The tag exists because a *copy* of a template's
  // content keeps no other trace of where it came from; a Template widget holds
  // settings.template_id, an exact link that renaming cannot break, so a tag
  // here would only be a second answer to a question already answered.
  const nameWidget = async (id, template) => {
    const title = String(template.title || "").trim();
    if (!title) return "";
    const res = await ns.callBridge("rename", { ids: [id], title });
    if (!res?.ok) {
      ns.log("warn", `Template insert: naming widget failed — ${res?.error}`);
      return " · rename failed";
    }
    return ` · named "${title}"`;
  };

  // Where the batch lands, in the words the status line uses. Widget mode has
  // its own end-of-page answer: the document root takes containers only, so the
  // widgets need one built for them.
  const destinationOf = (atSelection, asWidget, placement) => {
    if (atSelection && placement) return placement.describe;
    return asWidget ? "a new container at end of page" : "end of page";
  };

  // Name for the container built to hold an end-of-page widget batch. Something
  // readable, because an unnamed one reads as "Container" in the navigator.
  const WRAPPER_NAME = "Template Widgets";

  const makeBtn = (text, primary) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.style.cssText = `
      padding:7px 14px; border-radius:4px; font-size:13px; cursor:pointer;
      border: 1px solid ${primary ? "#3880ff" : "#555"};
      background: ${primary ? "#3880ff" : "transparent"};
      color: #fff;
    `;
    return b;
  };

  // Shown before the library fetch so the hotkey never sits silent. Any
  // tool doing a network round trip owes the user this — see CLAUDE.md.
  const openNotice = (message) => {
    document.getElementById(MODAL_ID)?.remove();

    const wrap = document.createElement("div");
    wrap.id = MODAL_ID;
    wrap.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0,0,0,0.45);
      display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;
    const card = document.createElement("div");
    card.style.cssText = `
      background: #2a2a2a; color: #fff; border-radius: 8px;
      padding: 20px 22px; width: 420px; max-width: 92vw;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5);
      display: flex; flex-direction: column; gap: 10px;
    `;
    const title = document.createElement("div");
    title.textContent = "Insert Site Templates";
    title.style.cssText = "font-size:15px;font-weight:600;";
    const status = document.createElement("div");
    status.textContent = message;
    status.style.cssText = "font-size:13px;color:#cfcfcf;";
    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
    card.append(title, status, btnRow);
    wrap.appendChild(card);
    document.body.appendChild(wrap);

    const close = () => wrap.remove();
    return {
      setStatus: (t) => (status.textContent = t),
      // Leaves the modal up with a dismiss button so the failure is readable.
      fail(text) {
        status.textContent = text;
        status.style.color = STATE_COLORS.error;
        const btn = makeBtn("Close", true);
        btn.addEventListener("click", close);
        btnRow.replaceChildren(btn);
        btn.focus();
        wrap.addEventListener("click", (e) => {
          if (e.target === wrap) close();
        });
      },
      close,
    };
  };

  // Picker over the whole library: filter box, checkbox per template,
  // insertion happens in the order the user ticked them.
  const openPicker = (templates, placement) =>
    new Promise((resolve) => {
      document.getElementById(MODAL_ID)?.remove();

      const wrap = document.createElement("div");
      wrap.id = MODAL_ID;
      wrap.style.cssText = `
        position: fixed; inset: 0; z-index: 2147483647;
        background: rgba(0,0,0,0.45);
        display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      `;

      const card = document.createElement("div");
      card.style.cssText = `
        background: #2a2a2a; color: #fff; border-radius: 8px;
        padding: 20px 22px; width: 560px; max-width: 92vw;
        box-shadow: 0 12px 40px rgba(0,0,0,0.5);
        display: flex; flex-direction: column; gap: 10px;
      `;
      wrap.appendChild(card);

      const title = document.createElement("div");
      title.textContent = "Insert Site Templates";
      title.style.cssText = "font-size:15px;font-weight:600;";
      card.appendChild(title);

      // Placement option. Off by default: the end of the page is what this tool
      // has always done, and the selection is only whatever was clicked last.
      let atSelection = false;
      // Content copy vs a Template widget pointing at the same template. Also
      // off by default — inserting the content is what this tool has always
      // done, and the two produce very different documents.
      let asWidget = false;

      const optionRow = (labelText, hintText, onChange) => {
        const row = document.createElement("label");
        row.style.cssText = `
          display:flex; align-items:flex-start; gap:8px; padding:6px 7px;
          cursor:pointer; border-radius:4px; font-size:12.5px;
          background:#222; border:1px solid #3a3a3a;
        `;
        const box = document.createElement("input");
        box.type = "checkbox";
        box.style.cssText =
          "accent-color:#3880ff;cursor:pointer;flex:0 0 auto;margin-top:2px;";
        box.addEventListener("change", () => onChange(box.checked));
        const text = document.createElement("span");
        text.style.cssText =
          "flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px;";
        const main = document.createElement("span");
        main.textContent = labelText;
        main.style.color = "#eee";
        const hint = document.createElement("span");
        hint.textContent = hintText;
        hint.style.cssText = "color:#777;font-size:11px;";
        text.append(main, hint);
        row.append(box, text);
        card.appendChild(row);
        return row;
      };

      if (placement) {
        optionRow(placement.label, placement.hint, (on) => {
          atSelection = on;
          renderStatus();
        });
      } else {
        const note = document.createElement("div");
        note.textContent =
          "Nothing selected in the editor — templates go to the end of the page.";
        note.style.cssText = "color:#777;font-size:11px;";
        card.appendChild(note);
      }

      optionRow(
        "Insert as Template widget",
        "one Elementor Template widget per template instead of a copy of its content — the block stays linked, so template edits follow",
        (on) => {
          asWidget = on;
          renderStatus();
        },
      );

      const smallBtn = (text) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        b.style.cssText = `
          flex:0 0 auto; padding:6px 9px; border-radius:4px;
          border:1px solid #555; background:transparent; color:#ccc;
          font-size:11px; cursor:pointer; white-space:nowrap;
        `;
        return b;
      };

      const searchRow = document.createElement("div");
      searchRow.style.cssText = "display:flex;gap:6px;align-items:center;";

      const filter = document.createElement("input");
      filter.type = "search";
      filter.placeholder = "Search templates…";
      filter.spellcheck = false;
      filter.autocomplete = "off";
      filter.style.cssText = `
        flex:1 1 auto; min-width:0; box-sizing:border-box;
        padding:7px 9px; border-radius:4px;
        border:1px solid #555; background:#1a1a1a; color:#fff;
        font-size:13px; outline:none;
      `;
      filter.addEventListener("focus", () => {
        filter.style.borderColor = "#3880ff";
      });
      filter.addEventListener("blur", () => {
        filter.style.borderColor = "#555";
      });

      const allBtn = smallBtn("Select shown");
      const noneBtn = smallBtn("Clear");
      searchRow.append(filter, allBtn, noneBtn);
      card.appendChild(searchRow);

      const list = document.createElement("div");
      list.style.cssText = `
        max-height: 340px; overflow-y: auto;
        background: #1a1a1a; border: 1px solid #3a3a3a; border-radius: 4px;
        padding: 4px 6px; font-size: 12.5px;
      `;
      card.appendChild(list);

      const status = document.createElement("div");
      status.style.cssText = "font-size:12px;color:#999;min-height:16px;";
      card.appendChild(status);

      const btnRow = document.createElement("div");
      btnRow.style.cssText =
        "display:flex;justify-content:flex-end;gap:8px;align-items:center;";
      card.appendChild(btnRow);

      // Ticked order is preserved so templates land in the order chosen.
      const picked = [];
      const rowFor = new Map();
      const boxFor = new Map();

      const isHidden = (t) => rowFor.get(t)?.style.display === "none";

      const renderStatus = () => {
        const shown = [...rowFor.values()].filter(
          (r) => r.style.display !== "none",
        ).length;
        // A ticked template scrolled out of the search still counts, so say so
        // rather than letting the number look wrong.
        const hiddenPicked = picked.filter(isHidden).length;

        const bits = [`${shown} of ${templates.length} shown`];
        bits.push(picked.length ? `${picked.length} selected` : "none selected");
        if (hiddenPicked) bits.push(`${hiddenPicked} hidden by search`);
        if (picked.length > 1) bits.push("insert order = tick order");
        if (asWidget) bits.push("as Template widgets");
        bits.push(`→ ${destinationOf(atSelection, asWidget, placement)}`);
        status.textContent = bits.join(" · ");

        insertBtn.disabled = !picked.length;
        insertBtn.style.opacity = picked.length ? "1" : "0.5";
        insertBtn.textContent = picked.length
          ? `Insert ${picked.length}`
          : "Insert";
      };

      const toggle = (t, on) => {
        const i = picked.indexOf(t);
        if (on && i < 0) picked.push(t);
        if (!on && i >= 0) picked.splice(i, 1);
        renderStatus();
      };

      for (const t of templates) {
        const row = document.createElement("label");
        row.style.cssText = `
          display:flex; align-items:flex-start; gap:8px; padding:5px 4px;
          cursor:pointer; border-radius:3px; word-break:break-word;
        `;
        row.addEventListener("mouseenter", () => {
          row.style.background = "#242424";
        });
        row.addEventListener("mouseleave", () => {
          row.style.background = "";
        });

        const box = document.createElement("input");
        box.type = "checkbox";
        box.style.cssText =
          "accent-color:#3880ff;cursor:pointer;flex:0 0 auto;margin-top:2px;";
        box.addEventListener("change", () => toggle(t, box.checked));

        const text = document.createElement("span");
        text.style.cssText =
          "flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px;";

        const name = document.createElement("span");
        name.textContent = t.title || "(untitled)";
        name.style.cssText = "color:#eee;";
        text.appendChild(name);

        const sub = metaLine(t);
        if (sub) {
          const subEl = document.createElement("span");
          subEl.textContent = sub;
          subEl.style.cssText = "color:#777;font-size:11px;";
          text.appendChild(subEl);
        }

        const meta = document.createElement("span");
        meta.textContent = t.type || "";
        meta.style.cssText =
          "flex:0 0 auto;color:#777;font-size:11px;font-family:ui-monospace,monospace;margin-top:1px;";

        row.append(box, text, meta);
        list.appendChild(row);
        rowFor.set(t, row);
        boxFor.set(t, box);
      }

      const applyFilter = () => {
        const terms = searchTerms(filter.value);
        for (const [t, row] of rowFor) {
          row.style.display = matchesTerms(t, terms) ? "flex" : "none";
        }
        renderStatus();
      };
      filter.addEventListener("input", applyFilter);
      filter.addEventListener("search", applyFilter);

      allBtn.addEventListener("click", () => {
        for (const [t, box] of boxFor) {
          if (isHidden(t) || box.checked) continue;
          box.checked = true;
          toggle(t, true);
        }
      });
      noneBtn.addEventListener("click", () => {
        for (const box of boxFor.values()) box.checked = false;
        picked.length = 0;
        renderStatus();
      });

      const cancelBtn = makeBtn("Cancel", false);
      const insertBtn = makeBtn("Insert", true);
      btnRow.append(cancelBtn, insertBtn);

      const finish = (value) => {
        document.removeEventListener("keydown", onKey, true);
        wrap.remove();
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        }
      };
      document.addEventListener("keydown", onKey, true);
      cancelBtn.addEventListener("click", () => finish(null));
      insertBtn.addEventListener("click", () =>
        finish({ picked: picked.slice(), atSelection, asWidget }),
      );
      wrap.addEventListener("click", (e) => {
        if (e.target === wrap) finish(null);
      });

      renderStatus();
      document.body.appendChild(wrap);
      setTimeout(() => filter.focus(), 0);
    });

  // Progress view, reusing the picker shell so the modal stays put.
  const openProgress = () => {
    document.getElementById(MODAL_ID)?.remove();

    const wrap = document.createElement("div");
    wrap.id = MODAL_ID;
    wrap.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0,0,0,0.45);
      display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;
    const card = document.createElement("div");
    card.style.cssText = `
      background: #2a2a2a; color: #fff; border-radius: 8px;
      padding: 20px 22px; width: 520px; max-width: 92vw;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5);
      display: flex; flex-direction: column; gap: 12px;
    `;
    wrap.appendChild(card);

    const title = document.createElement("div");
    title.textContent = "Insert Site Templates";
    title.style.cssText = "font-size:15px;font-weight:600;";
    const status = document.createElement("div");
    status.style.cssText = "font-size:13px;color:#cfcfcf;";
    const list = document.createElement("div");
    list.style.cssText = `
      max-height: 300px; overflow-y: auto;
      background: #1a1a1a; border: 1px solid #3a3a3a; border-radius: 4px;
      padding: 6px 8px; font-size: 12px; line-height: 1.5;
      font-family: ui-monospace, monospace;
    `;
    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
    card.append(title, status, list, btnRow);
    document.body.appendChild(wrap);

    // Same tail-following as the shared modal: scrollIntoView scrolls every
    // ancestor and forces a layout of the whole editor, and it fights the user
    // the moment they scroll up. One row per ticked template is a smaller burst
    // than a sync's, but there is no reason for it to behave differently.
    const PIN_SLACK = 24;
    let pinned = true;
    let tailQueued = false;
    list.addEventListener("scroll", () => {
      pinned =
        list.scrollHeight - list.scrollTop - list.clientHeight <= PIN_SLACK;
    });
    const followTail = () => {
      if (!pinned || tailQueued) return;
      tailQueued = true;
      requestAnimationFrame(() => {
        tailQueued = false;
        list.scrollTop = list.scrollHeight;
      });
    };

    const rows = new Map();
    return {
      setStatus: (t) => (status.textContent = t),
      addRow(id, label) {
        const row = document.createElement("div");
        row.style.cssText = "padding:2px 0;word-break:break-word;";
        const n = document.createElement("span");
        n.textContent = label;
        n.style.color = "#eee";
        const d = document.createElement("span");
        d.style.color = STATE_COLORS.pending;
        d.textContent = " — waiting";
        row.append(n, d);
        list.appendChild(row);
        rows.set(id, d);
        followTail();
      },
      setRow(id, state, text) {
        const d = rows.get(id);
        if (!d) return;
        d.style.color = STATE_COLORS[state] || STATE_COLORS.pending;
        d.textContent = ` — ${text}`;
      },
      finish(summary, state) {
        status.textContent = summary;
        status.style.color = STATE_COLORS[state] || "#cfcfcf";
        const close = makeBtn("Close", true);
        close.addEventListener("click", () => wrap.remove());
        btnRow.replaceChildren(close);
        close.focus();
        wrap.addEventListener("click", (e) => {
          if (e.target === wrap) wrap.remove();
        });
      },
      close: () => wrap.remove(),
    };
  };

  const insertTemplates = async () => {
    if (running) {
      ns.log("warn", "Template insert: already running");
      return;
    }
    running = true;
    try {
      const notice = openNotice("Fetching site templates…");
      // Read the selection up front: the picker is a full-screen overlay, so it
      // cannot change while the modal is open. A failed read is non-fatal — the
      // option simply isn't offered.
      const [res, placement] = await Promise.all([
        ns.listSiteTemplates({ onWait: waitStatus(notice) }),
        readPlacement(),
      ]);
      if (!res?.ok) {
        ns.log("warn", `Template insert: ${res?.error}`);
        notice.fail(`Could not fetch templates — ${res?.error}`);
        return;
      }
      const templates = (res.templates || []).slice().sort((a, b) =>
        String(a.title || "").localeCompare(String(b.title || "")),
      );
      if (!templates.length) {
        ns.log("warn", "Template insert: library is empty");
        notice.fail("No site templates found in this library.");
        return;
      }

      notice.close();
      const choice = await openPicker(templates, placement);
      if (!choice) {
        ns.log("info", "Template insert: cancelled");
        return;
      }
      const { picked, asWidget } = choice;
      const target = choice.atSelection ? placement : null;
      const where = destinationOf(choice.atSelection, asWidget, placement);

      const modal = openProgress();
      for (let i = 0; i < picked.length; i++) {
        modal.addRow(i, `${i + 1}. ${picked[i].title}`);
      }

      // Fetch every ticked template's content first, a few requests at a time, so
      // the serial insert loop below is only paying for the edits. Failures are
      // non-fatal: that template's own insert fetches it again.
      //
      // Widget mode never reads a template's content — it only writes an id into
      // a setting — so there is nothing to warm, and a preload failure reported
      // on those rows would be describing work the run does not do.
      if (!asWidget && picked.length > 1) {
        modal.setStatus(
          `Loading ${picked.length} template(s), ${ns.PREFETCH_CONCURRENCY} at a time…`,
        );
        const pre = await ns.prefetchTemplates(picked, {
          onWait: waitStatus(modal),
        });
        for (const f of pre.failed || []) {
          const i = picked.findIndex((t) => String(t.templateId) === f.templateId);
          if (i >= 0) modal.setRow(i, "warn", "preload failed — will retry");
        }
      }

      // waitLimit 1: both history ops degrade to a no-op already, and history-end
      // runs in a finally after the summary is on screen — a re-arming wait there
      // holds the undo group open long enough for a user edit to join this run's
      // undo step, with the hotkey locked meanwhile.
      const historyRes = await ns.callBridge(
        "history-start",
        {
          title: asWidget ? "Insert template widgets" : "Insert site templates",
        },
        { waitLimit: 1 },
      );
      const logId = historyRes?.ok ? historyRes.logId : null;

      // For the after-a-sibling case the anchor advances to whatever was just
      // inserted, so several templates keep their tick order instead of each
      // one landing in front of the last.
      let args = target ? { ...target.args } : {};

      let done = 0;
      let failed = 0;
      // Set when nothing can be attempted at all, so the rows say why rather
      // than sitting on "waiting" forever.
      let fatal = null;
      try {
        // A widget needs a parent that can hold one. A selected container is
        // one, and a selected widget puts them after it inside its own parent —
        // but the end of the page is the document root, which takes containers
        // only. So build one, inside this run's undo step, and fill it.
        if (asWidget && !target) {
          modal.setStatus("Creating a container to hold the template widgets…");
          const wrapper = await ns.createContainer({
            onWait: waitStatus(modal),
          });
          if (!wrapper?.ok) {
            fatal = `could not create a container — ${wrapper?.error}`;
          } else {
            args = { intoId: wrapper.id };
            const named = await ns.callBridge("rename", {
              ids: [wrapper.id],
              title: WRAPPER_NAME,
            });
            if (!named?.ok) {
              ns.log(
                "warn",
                `Template insert: naming wrapper failed — ${named?.error}`,
              );
            }
          }
        }

        for (let i = 0; i < picked.length && !fatal; i++) {
          const t = picked[i];
          if (asWidget) {
            modal.setStatus(
              `Creating Template widget for "${t.title}" → ${where} (${i + 1}/${picked.length})…`,
            );
            modal.setRow(i, "running", "creating widget");
            const made = await ns.createTemplateWidget(t.templateId, {
              ...args,
              onWait: waitStatus(modal),
            });
            if (!made?.ok) {
              failed++;
              modal.setRow(i, "error", `failed — ${made?.error}`);
              continue;
            }
            done++;
            const named = await nameWidget(made.id, t);
            modal.setRow(i, "ok", `Template widget created${named}`);
            if (args.afterId) args = { afterId: made.id };
            continue;
          }

          modal.setStatus(
            `Inserting "${t.title}" → ${where} (${i + 1}/${picked.length})…`,
          );
          modal.setRow(i, "running", "inserting");
          const ins = await ns.insertSiteTemplate(t.templateId, {
            source: t.source,
            title: t.title,
            type: t.type,
            onWait: waitStatus(modal),
            ...args,
          });
          if (!ins?.ok) {
            failed++;
            modal.setRow(i, "error", `failed — ${ins?.error}`);
            continue;
          }
          done++;
          const ids = ins.ids || [];
          const named = await nameRoots(ids, t);
          modal.setRow(i, "ok", `inserted ${ids.length} element(s)${named}`);
          if (args.afterId && ids.length) {
            args = { afterId: ids[ids.length - 1] };
          }
        }
      } finally {
        if (logId !== null && logId !== undefined) {
          await ns.callBridge("history-end", { logId }, { waitLimit: 1 });
        }
      }

      if (fatal) {
        for (let i = 0; i < picked.length; i++) {
          modal.setRow(i, "error", `not attempted — ${fatal}`);
        }
        ns.log("warn", `Template insert: ${fatal}`);
        modal.finish(`Nothing inserted — ${fatal}`, "error");
        return;
      }

      const verb = asWidget ? "created" : "inserted";
      const summary = `${done} ${verb}, ${failed} failed · ${where}`;
      ns.log(done ? "info" : "warn", `Template insert: ${summary}`);
      modal.finish(summary, failed ? "warn" : "ok");
    } catch (err) {
      ns.log("error", `Template insert: ${err?.message || err}`);
    } finally {
      running = false;
    }
  };

  ns.insertTemplates = insertTemplates;
})();
