(() => {
  if (!location.search.includes("action=elementor")) return;

  const ns = (window.__ElementorTools = window.__ElementorTools || {});

  const NAV_ELEMENT = ".elementor-navigator__element[data-id]";
  const TITLE_SELECTOR = ".elementor-navigator__element__title__text";
  const MODAL_ID = "ElementorTools-batch-rename-modal";

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const findRow = (id) =>
    document.querySelector(`${NAV_ELEMENT}[data-id="${CSS.escape(id)}"]`);

  const ensureVisible = async (id) => {
    let row = findRow(id);
    if (row) return row;
    ns.selectLayerById?.(id);
    await wait(80);
    return findRow(id);
  };

  const renameOne = async (id, newName) => {
    const row = await ensureVisible(id);
    if (!row) return { ok: false, error: "row not found" };

    const span = row.querySelector(
      `:scope > .elementor-navigator__item ${TITLE_SELECTOR}`,
    );
    if (!span) return { ok: false, error: "title span not found" };

    span.dispatchEvent(
      new MouseEvent("dblclick", {
        bubbles: true,
        cancelable: true,
        view: window,
        detail: 2,
      }),
    );
    await wait(50);

    if (span.getAttribute("contenteditable") !== "true") {
      span.setAttribute("contenteditable", "true");
    }
    span.focus();

    span.textContent = newName;

    // Move caret to end so blur doesn't lose the change
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(span);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    span.dispatchEvent(new InputEvent("input", { bubbles: true }));

    span.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
    span.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
      }),
    );
    span.blur();
    span.dispatchEvent(new FocusEvent("blur", { bubbles: false }));

    return { ok: true };
  };

  const removeModal = () => {
    document.getElementById(MODAL_ID)?.remove();
  };

  const openModal = (count) =>
    new Promise((resolve) => {
      removeModal();

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
        padding: 20px 22px; min-width: 320px; max-width: 420px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.5);
      `;
      wrap.appendChild(card);

      const title = document.createElement("div");
      title.textContent = `Rename ${count} layer${count === 1 ? "" : "s"}`;
      title.style.cssText = "font-size:15px;font-weight:600;margin-bottom:12px;";
      card.appendChild(title);

      const label = document.createElement("label");
      label.textContent = "New name";
      label.style.cssText =
        "font-size:12px;opacity:0.8;display:block;margin-bottom:6px;";
      card.appendChild(label);

      const input = document.createElement("input");
      input.type = "text";
      input.style.cssText = `
        width: 100%; box-sizing: border-box;
        padding: 8px 10px; border-radius: 4px;
        border: 1px solid #555; background: #1a1a1a; color: #fff;
        font-size: 14px; margin-bottom: 16px; outline: none;
      `;
      card.appendChild(input);

      const btnRow = document.createElement("div");
      btnRow.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
      card.appendChild(btnRow);

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

      const cancelBtn = makeBtn("Cancel", false);
      const okBtn = makeBtn("Rename", true);
      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(okBtn);

      const finish = (value) => {
        document.removeEventListener("keydown", onKey, true);
        removeModal();
        resolve(value);
      };

      const onKey = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        } else if (e.key === "Enter" && document.activeElement === input) {
          e.preventDefault();
          e.stopPropagation();
          finish(input.value.trim());
        }
      };
      document.addEventListener("keydown", onKey, true);

      cancelBtn.addEventListener("click", () => finish(null));
      okBtn.addEventListener("click", () => finish(input.value.trim()));
      wrap.addEventListener("click", (e) => {
        if (e.target === wrap) finish(null);
      });

      document.body.appendChild(wrap);
      setTimeout(() => input.focus(), 0);
    });

  const batchRename = async () => {
    if (document.getElementById(MODAL_ID)) return;

    const ids = ns.multiSelect?.getIds?.() || [];
    if (!ids.length) {
      ns.log?.("warn", "Batch rename: nothing selected");
      return;
    }

    const newName = await openModal(ids.length);
    if (newName === null) {
      ns.log?.("info", "Batch rename: cancelled");
      return;
    }
    if (!newName) {
      ns.log?.("warn", "Batch rename: empty name");
      return;
    }

    ns.log?.("info", `Batch rename: ${ids.length} → "${newName}"`);

    let done = 0;
    for (const id of ids) {
      const res = await renameOne(id, newName);
      if (!res.ok) {
        ns.log?.("warn", `Batch rename: ${id} failed — ${res.error}`);
        continue;
      }
      done++;
      await wait(40);
    }

    ns.log?.("info", `Batch rename: renamed ${done}/${ids.length}`);
  };

  ns.batchRename = batchRename;
})();
