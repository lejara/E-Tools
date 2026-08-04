// Component system — the Structure panel banner.
//
// A container that is a component root gets a blue banner in Elementor's
// navigator, so you can see which blocks are components without opening
// anything. Read-only decoration: it never writes to the document and never
// touches the selection.
//
// Two things about the navigator were already settled by Tools/multi-select.js
// and are followed rather than rediscovered:
//   - Elementor re-renders the navigator on collapse, expand and edit, so the
//     tint has to be re-applied by a MutationObserver keyed on data-id.
//   - The row is styled through its child .elementor-navigator__item, not the
//     [data-id] element itself, which is only a positioning wrapper.
(() => {
  if (!location.search.includes("action=elementor")) return;

  const ns = (window.__ElementorComponents = window.__ElementorComponents || {});

  const ROOT_BASE_CLASS = "ElementorComponents-base";
  const ROOT_INSTANCE_CLASS = "ElementorComponents-instance";
  const ADDED_CLASS = "ElementorComponents-added";
  const OVERRIDDEN_CLASS = "ElementorComponents-overridden";
  const ALL_CLASSES = [
    ROOT_BASE_CLASS,
    ROOT_INSTANCE_CLASS,
    ADDED_CLASS,
    OVERRIDDEN_CLASS,
  ];

  // The `*` override marker is OFF pending a fix — it was marking rows it
  // should not. Switched off here rather than deleted, because the plumbing
  // behind it (the live derivation in `component-markers`) is shared with
  // nothing else and would only have to be written again.
  //
  // The op still reports `overridden`; this is the only thing that reads it, so
  // flipping this back to true is the whole re-enable. The `+` added marker is
  // unaffected and stays on — it is computed from the node map, not from
  // derivation, which is the part that is suspect.
  const SHOW_OVERRIDE_MARKER = false;
  const NAV_ELEMENT = ".elementor-navigator__element[data-id]";
  const NAV_SCOPE =
    "#elementor-navigator, .elementor-navigator, .elementor-navigator__elements";

  // Orange, deliberately NOT blue: multi-select.js tints a shift-clicked row
  // rgba(56,128,255,0.35), and a blue banner here was indistinguishable from a
  // selection at a glance. The two mean completely different things — one is
  // "this is a component", the other is "you picked this" — and they routinely
  // appear on the same row, so they have to differ by hue rather than by a
  // small alpha step.
  //
  // One hue, two strengths, because base and instance are the same kind of
  // thing at different weights: a base DEFINES the block, an instance merely
  // follows one. A page full of instances would be a wall of orange at full
  // strength, and the one row that actually defines something would not stand
  // out — which is the whole job of the banner.
  //
  // Selection still wins the cascade where both apply: its rule carries
  // !important and these do not.
  const BANNER_BASE = "rgba(255, 149, 0, 0.3)";
  const BANNER_INSTANCE = "rgba(255, 149, 0, 0.1)";

  // Row markers sit in ::before on the element-type icon, which is the element
  // immediately after the expand arrow — so the marker lands between the two,
  // which is where "next to the arrow" actually is.
  //
  // That target was measured rather than picked. On Elementor 4.2.1 a row is
  //   .elementor-navigator__item
  //     > .elementor-navigator__element__list-toggle   (the arrow)
  //     > .elementor-navigator__element__element-type  (the kind icon)
  //     > .elementor-navigator__element__title
  // The type icon is present on EVERY row — including leaves, where the arrow
  // collapses to zero width — and its ::before computes to `none` on all of
  // them, so nothing of Elementor's is being displaced. The arrow's own
  // ::after was the other candidate and is worse: it is a zero-width flex item
  // on leaf rows, so giving it content would shift the row.
  //
  // Two static rules rather than content:attr(). attr() reads the attribute of
  // the element the pseudo belongs to, not an ancestor, so a data attribute
  // would have to go on the inner icon — which Elementor re-renders. The class
  // goes on the row, which is what the retint already keys on.
  const MARKER = `
    flex: 0 0 auto;
    margin-right: 3px;
    font: 700 11px/1 ui-monospace, monospace;
    pointer-events: none;
  `;

  const style = document.createElement("style");
  style.textContent = `
    .${ROOT_BASE_CLASS} > .elementor-navigator__item {
      background: ${BANNER_BASE};
    }
    .${ROOT_INSTANCE_CLASS} > .elementor-navigator__item {
      background: ${BANNER_INSTANCE};
    }
    .${ADDED_CLASS} > .elementor-navigator__item
      > .elementor-navigator__element__element-type::before {
      content: "+";
      color: #6ac47a;
      ${MARKER}
    }
    .${OVERRIDDEN_CLASS} > .elementor-navigator__item
      > .elementor-navigator__element__element-type::before {
      content: "*";
      color: #e0b060;
      ${MARKER}
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  // Root container ids, not data-widget ids. The widget is infrastructure the
  // user should not be looking at; the container holding it is the component.
  let baseIds = new Set();
  let instanceIds = new Set();
  // Nodes this instance added, and nodes carrying overrides. Both are keyed on
  // the LIVE element id, so the paint is a plain data-id lookup like the tint.
  let addedIds = new Set();
  let overriddenIds = new Set();

  const anyMarks = () =>
    baseIds.size || instanceIds.size || addedIds.size || overriddenIds.size;

  const paint = () => {
    for (const cls of ALL_CLASSES) {
      for (const el of document.querySelectorAll(`.${cls}`)) el.classList.remove(cls);
    }
    if (!anyMarks()) return;
    for (const el of document.querySelectorAll(NAV_ELEMENT)) {
      const id = el.getAttribute("data-id");
      el.classList.toggle(ROOT_BASE_CLASS, baseIds.has(id));
      el.classList.toggle(ROOT_INSTANCE_CLASS, instanceIds.has(id));
      // An added node is not mapped, so it cannot also be overridden — the two
      // are mutually exclusive and never both land on one row.
      el.classList.toggle(ADDED_CLASS, addedIds.has(id));
      el.classList.toggle(OVERRIDDEN_CLASS, overriddenIds.has(id));
    }
  };

  // One op answers all three questions. The navigator repaints on every
  // collapse, expand and edit, so the observer repaints from the last answer
  // rather than re-asking — a round trip per mutation would turn a decoration
  // into a performance problem.
  const refresh = async () => {
    try {
      const res = await ns.callBridge?.("component-markers", {}, { waitLimit: 1 });
      if (!res?.ok) return;
      baseIds = new Set(res.baseRoots || []);
      instanceIds = new Set(res.instanceRoots || []);
      addedIds = new Set(res.added || []);
      overriddenIds = SHOW_OVERRIDE_MARKER ? new Set(res.overridden || []) : new Set();
      paint();
    } catch (_) {
      // The bridge not being up yet is normal during editor boot; the retry
      // below covers it and a missing marker costs nothing.
    }
  };

  // Repaint on navigator churn. Attribute writes are not observed and class
  // toggling is an attribute write, so this cannot feed itself — the same
  // property multi-select.js relies on for its own retint.
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      paint();
    });
  });

  const observe = () => {
    for (const scope of document.querySelectorAll(NAV_SCOPE)) {
      observer.observe(scope, { childList: true, subtree: true });
    }
  };

  // The navigator is created lazily — it does not exist until it is first
  // opened — so the scope has to be re-observed rather than found once.
  const bodyObserver = new MutationObserver(() => {
    observe();
    paint();
  });
  bodyObserver.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });

  observe();

  // Elementor's own boot can be well behind document_idle, and the bridge has
  // its own readiness handshake on top of that. Poll briefly rather than
  // guessing a delay; once a scan answers, the observers keep it current.
  let attempts = 0;
  const tick = async () => {
    attempts++;
    await refresh();
    if (!anyMarks() && attempts < 20) setTimeout(tick, 1000);
  };
  tick();

  ns.navigator = { refresh, paint };
})();
