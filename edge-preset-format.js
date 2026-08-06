// Loaded both as a content script and by Automation/automation.html — the
// Automation window authors Edge Presets and the editor captures into them and
// applies them, so the schema, the path encoding, the instance-matching rule and
// the import validator all have to be one thing. Same dual-context pattern as
// animation-preset-fields.js and template-format.js, and for the same reason: a
// second copy of the shape is exactly how a writer and a reader drift.
//
// WHAT AN EDGE PRESET IS
//
// A sync pastes a template's *style* controls onto its instances. It cannot
// touch a button's label, a link URL, an icon choice or any other non-style
// setting, because `paste-style` only walks style-transfer controls. An Edge
// Preset is the named list of fields to force-push from the template to its
// instances anyway — the edges a sync cannot reach, hence the name.
//
// It is authored in the *template's own editor*, which is what makes the binding
// exact: the document id IS the template id, so nothing has to be inferred. One
// preset is bound to one template; many presets may share a template.
//
// Values are a SNAPSHOT, taken at capture time. Editing the template later does
// not update the preset — re-capture does. That is a deliberate trade for a
// self-contained, exportable preset that applies with no network call at all.
//
// STRUCTURAL EDITS (v2)
//
// A preset may also carry ONE structural edit: add a node, rename a node, or
// remove a node. These address the node's PARENT container plus the child index,
// which is deliberately the same strength of address a field capture already has
// — it buys no extra confidence on its own.
//
// The confidence comes from MATCHING CONDITIONS: author-declared gates evaluated
// against the matched parent before anything is written. That is the whole answer
// to "how do we know this node is missing rather than moved" — the tool stops
// inferring and the author states the precondition. A condition that fails is a
// GATE, which is a designed no-op and reported separately from a skip.
(() => {
  // Bump when the stored shape changes. A file from a newer build is refused
  // rather than half-read, the same call INDEX_VERSION makes for the usage
  // cache: reading a shape you only partly understand writes wrong values into
  // real pages, and here there is no scan to re-earn it from.
  //
  // v2 added `edits`. A v1 file still reads: it simply carries none.
  const EDGE_PRESET_VERSION = 2;

  const STORAGE_KEY = "edgePresets";

  // The two field shapes mirror the flyout's right-click menu, which is where
  // Capture lives:
  //
  //   { scope: "field",   control, label, type, responsive, values: {key: v} }
  //   { scope: "section", section, label,                   values: {key: v} }
  //
  // In BOTH shapes `values` is keyed by CONTROL KEY — `border_radius_tablet`,
  // not `tablet`. This is the one place the format deliberately departs from the
  // clipboard payload, which keys a field by DEVICE.
  //
  // The clipboard has to key by device because its whole point is pasting
  // between two *different* fields whose key names differ (`padding` into
  // `margin`). An Edge Preset never does that: it writes the same field of the
  // same widget type it was captured from, and the type check at apply time is
  // what guarantees it. So the key names on both ends are identical by
  // construction, the device mapping has nothing to do, and dropping it makes
  // apply one uniform loop over `[key, value]` for fields and sections alike —
  // no second copy of resolveBase/buildFamily in the bridge to drift from the
  // flyout's.
  const FIELD_SCOPES = new Set(["field", "section"]);

  const isInt = (v) => Number.isInteger(v) && v >= 0;

  const asPositiveInt = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  // Not cryptographic and does not need to be: `id` only has to be stable for
  // the lifetime of a preset, because it is what Import matches on to decide
  // replace-or-add. Same job as the animation preset id.
  const newPresetId = () =>
    `ep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const makePreset = (name) => ({
    v: EDGE_PRESET_VERSION,
    id: newPresetId(),
    name: String(name || "").trim() || "Untitled edge preset",
    // Unbound until the first capture. A preset with no templateId can be
    // renamed and deleted but never applied — there is no set of instances for
    // it to name yet.
    templateId: null,
    templateTitle: "",
    nodes: [],
    // At most one — see mergeStructural.
    edits: [],
  });

  // ------------------------------------------------------------------- paths

  // A node is addressed by which template ROOT it sits under (1-based, matching
  // the tag and how every tool here labels roots) plus the child-index path from
  // that root down to the element. The type at the leaf travels with it so a
  // shifted index is *detected* rather than silently written to the wrong
  // element — see resolveNode below for why detection is all this design does.
  const nodeKey = (node) =>
    `${asPositiveInt(node?.root) || 1}:${(node?.path || []).join(".")}`;

  const nodeSignature = (node) =>
    node?.widgetType
      ? `widget:${node.widgetType}`
      : String(node?.elType || "element");

  // "root 2 › 3 › 1 (widget:button)". Read by both the capture confirmation and
  // every skip report, so a path the user has to act on always reads the same.
  const pathLabel = (node) => {
    const root = asPositiveInt(node?.root) || 1;
    const steps = (node?.path || []).join(" › ");
    const where = steps ? `root ${root} › ${steps}` : `root ${root}`;
    return `${where} (${nodeSignature(node)})`;
  };

  // The identity of one captured field *within* a node, so capturing the same
  // field twice replaces rather than appends. Naming twice being idempotent is
  // the same instinct withTemplateTag follows.
  const fieldKey = (field) =>
    field?.scope === "section"
      ? `section:${field.section}`
      : `field:${field.control}`;

  const fieldLabel = (field) =>
    field?.scope === "section"
      ? `${field.label || field.section} · whole section`
      : field?.label || field?.control || "field";

  // How many individual control keys a preset will write. The honest number to
  // show in the GUI: a single section capture is one *field* row and can be two
  // hundred keys.
  const valueCount = (field) => Object.keys(field?.values || {}).length;

  const describePreset = (preset) => {
    const nodes = (preset?.nodes || []).length;
    let fields = 0;
    let values = 0;
    for (const node of preset?.nodes || []) {
      for (const field of node.fields || []) {
        fields += 1;
        values += valueCount(field);
      }
    }
    return { nodes, fields, values, edits: (preset?.edits || []).length };
  };

  // -------------------------------------------------------------- capturing

  // Fold one capture into a preset, returning a new object rather than mutating:
  // the caller holds the stored list and writes it back, and an in-place edit of
  // a value read out of storage is how a failed write leaves the UI showing
  // something that was never saved.
  //
  // Binds the template on the first capture. A capture naming a different
  // template is refused here rather than at the call site, because this is the
  // one place that knows a preset is single-template.
  const mergeCapture = (preset, capture) => {
    const base = preset || makePreset("");
    const templateId = asPositiveInt(capture?.templateId);
    if (!templateId) {
      return { ok: false, error: "capture carries no template id" };
    }
    if (base.templateId && String(base.templateId) !== String(templateId)) {
      return {
        ok: false,
        error:
          `this preset is bound to template #${base.templateId}` +
          ` — captures must come from that template's editor`,
      };
    }
    const incoming = {
      root: asPositiveInt(capture.root) || 1,
      path: (capture.path || []).filter(isInt),
      elType: capture.elType || null,
      widgetType: capture.widgetType || null,
      label: capture.label || "",
      fields: [],
    };
    const field = capture.field;
    if (!field || !FIELD_SCOPES.has(field.scope)) {
      return { ok: false, error: "capture carries no field" };
    }
    if (!valueCount(field)) {
      return { ok: false, error: "capture carries no values" };
    }

    const nodes = (base.nodes || []).map((n) => ({
      ...n,
      fields: [...(n.fields || [])],
    }));
    const key = nodeKey(incoming);
    let node = nodes.find((n) => nodeKey(n) === key);
    if (!node) {
      node = incoming;
      nodes.push(node);
    } else {
      // The element may have been renamed in the template since the last
      // capture; the label is only ever for reporting, so take the fresh one.
      node.label = incoming.label || node.label;
      node.elType = incoming.elType || node.elType;
      node.widgetType = incoming.widgetType ?? node.widgetType;
    }

    const fkey = fieldKey(field);
    const at = node.fields.findIndex((f) => fieldKey(f) === fkey);
    const replaced = at >= 0;
    if (replaced) node.fields[at] = field;
    else node.fields.push(field);

    return {
      ok: true,
      replaced,
      preset: {
        ...base,
        v: EDGE_PRESET_VERSION,
        templateId: String(templateId),
        templateTitle: capture.templateTitle || base.templateTitle || "",
        nodes,
      },
    };
  };

  const removeNode = (preset, key) => ({
    ...preset,
    nodes: (preset?.nodes || []).filter((n) => nodeKey(n) !== key),
  });

  const removeField = (preset, key, fkey) => ({
    ...preset,
    nodes: (preset?.nodes || [])
      .map((n) =>
        nodeKey(n) === key
          ? { ...n, fields: (n.fields || []).filter((f) => fieldKey(f) !== fkey) }
          : n,
      )
      // A node whose last field was removed addresses nothing, so it goes too
      // rather than sitting in the list writing zero keys.
      .filter((n) => (n.fields || []).length),
  });

  // ------------------------------------------------------- structural edits

  const EDIT_OPS = new Set(["add", "rename", "remove"]);

  // Where an added node goes inside the matched parent. "index" is the position
  // the node held in the template; the other three exist because a page's own
  // extra children make a captured index mean the wrong place. A named anchor
  // survives that, which is why it is offered at all.
  const PLACE_MODES = new Set(["index", "append", "before", "after"]);

  // The gates. The GUI renders from this table and the page-side evaluator reads
  // the same `kind` strings — it cannot read this global (page world), so it
  // carries its own switch. Change a kind here, change it there.
  const CONDITION_KINDS = [
    {
      kind: "child-count",
      label: "Number of children",
      fields: ["cmp", "value"],
    },
    {
      kind: "child-named",
      label: "A child named…",
      fields: ["name", "present"],
    },
    {
      kind: "child-of-type",
      label: "A child of type…",
      fields: ["signature", "present"],
    },
    {
      kind: "index-type",
      label: "The child at index…",
      fields: ["index", "signature"],
    },
  ];
  const CONDITION_KIND_SET = new Set(CONDITION_KINDS.map((c) => c.kind));
  const COMPARATORS = new Set(["==", "!=", ">=", "<="]);

  const newEditId = () =>
    `ee_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  // The parent's address, in exactly the form nodeKey gives a field capture.
  const editParentKey = (edit) =>
    `${asPositiveInt(edit?.root) || 1}:${(edit?.path || []).join(".")}`;

  const editSignature = (edit) =>
    edit?.childWidgetType
      ? `widget:${edit.childWidgetType}`
      : String(edit?.childElType || "element");

  const OP_VERB = { add: "Add", rename: "Rename", remove: "Remove" };

  const editLabel = (edit) => {
    const what =
      edit?.childLabel || editSignature(edit) || "node";
    const parent = edit?.parentLabel
      ? `"${edit.parentLabel}"`
      : `root ${asPositiveInt(edit?.root) || 1}`;
    return `${OP_VERB[edit?.op] || "Edit"} "${what}" in ${parent}`;
  };

  const conditionLabel = (c) => {
    if (c?.kind === "child-count") return `child count ${c.cmp} ${c.value}`;
    if (c?.kind === "child-named") {
      return `a child named "${c.name}" ${c.present ? "exists" : "does not exist"}`;
    }
    if (c?.kind === "child-of-type") {
      return `a child of type ${c.signature} ${c.present ? "exists" : "does not exist"}`;
    }
    if (c?.kind === "index-type") {
      return `the child at index ${c.index} is ${c.signature}`;
    }
    return "unknown condition";
  };

  // Drops anything malformed rather than half-keeping it, for the same reason a
  // malformed field is dropped: a condition that silently does not gate is worse
  // than one that is missing, because the write happens either way.
  const normalizeCondition = (c) => {
    if (!c || !CONDITION_KIND_SET.has(c.kind)) return null;
    if (c.kind === "child-count") {
      const value = Number(c.value);
      if (!COMPARATORS.has(c.cmp) || !Number.isInteger(value) || value < 0) {
        return null;
      }
      return { kind: "child-count", cmp: c.cmp, value };
    }
    if (c.kind === "child-named") {
      const name = String(c.name || "").trim();
      if (!name) return null;
      return { kind: "child-named", name, present: c.present !== false };
    }
    if (c.kind === "child-of-type") {
      const signature = String(c.signature || "").trim();
      if (!signature) return null;
      return {
        kind: "child-of-type",
        signature,
        present: c.present !== false,
      };
    }
    const index = Number(c.index);
    const signature = String(c.signature || "").trim();
    if (!isInt(index) || !signature) return null;
    return { kind: "index-type", index, signature };
  };

  // Rename and Remove act on whatever sits at a child index, and the index alone
  // is a position. The current design type-checks the LEAF of a field capture, so
  // without this an edit addressed at the parent would be strictly weaker than
  // what it replaces. Attached automatically, not offered as a choice.
  const autoConditionFor = (edit) => {
    if (edit?.op === "add") return null;
    return normalizeCondition({
      kind: "index-type",
      index: edit?.index,
      signature: editSignature(edit),
    });
  };

  const withAutoCondition = (edit) => {
    const auto = autoConditionFor(edit);
    if (!auto) return edit.conditions || [];
    const already = (edit.conditions || []).some(
      (c) =>
        c.kind === "index-type" &&
        c.index === auto.index &&
        c.signature === auto.signature,
    );
    return already ? edit.conditions : [auto, ...(edit.conditions || [])];
  };

  // A CSS ID is unique per document by definition, and an added node is planted
  // on every matched instance of every page in the run. template-decouple drops
  // _element_id for exactly this reason when one widget becomes several siblings;
  // here one captured node becomes hundreds. Recursive, because a subtree carries
  // one per element.
  const stripElementIds = (node) => {
    if (Array.isArray(node)) return node.map(stripElementIds);
    if (!node || typeof node !== "object") return node;
    const out = { ...node };
    if (out.settings && typeof out.settings === "object") {
      const { _element_id, ...rest } = out.settings;
      out.settings = rest;
    }
    if (Array.isArray(out.elements)) out.elements = out.elements.map(stripElementIds);
    return out;
  };

  const normalizePlace = (place, fallbackIndex) => {
    const mode = PLACE_MODES.has(place?.mode) ? place.mode : "index";
    const out = { mode };
    if (mode === "index") {
      const n = Number(place?.index ?? fallbackIndex);
      out.index = isInt(n) ? n : 0;
    }
    if (mode === "before" || mode === "after") {
      out.anchorName = String(place?.anchorName || "").trim();
    }
    return out;
  };

  const normalizeEdit = (raw) => {
    if (!raw || !EDIT_OPS.has(raw.op)) {
      return { ok: false, error: "edit has no recognised operation" };
    }
    const path = Array.isArray(raw.path) ? raw.path.map(Number) : null;
    if (!path || !path.every(isInt)) {
      return { ok: false, error: "edit parent path must be a list of child indices" };
    }
    const index = Number(raw.index);
    if (!isInt(index)) {
      return { ok: false, error: "edit carries no child index" };
    }
    const edit = {
      id: typeof raw.id === "string" && raw.id ? raw.id : newEditId(),
      op: raw.op,
      root: asPositiveInt(raw.root) || 1,
      path,
      index,
      parentElType: raw.parentElType || null,
      parentWidgetType: raw.parentWidgetType || null,
      parentLabel: raw.parentLabel || "",
      childElType: raw.childElType || null,
      childWidgetType: raw.childWidgetType || null,
      childLabel: raw.childLabel || "",
      conditions: (Array.isArray(raw.conditions) ? raw.conditions : [])
        .map(normalizeCondition)
        .filter(Boolean),
    };

    if (raw.op === "add") {
      if (!raw.node || typeof raw.node !== "object") {
        return { ok: false, error: "an add carries no node to create" };
      }
      // The guard for a repeat run is almost always "no child named X", and it
      // cannot be written against a node with no name. Refusing here rather than
      // at apply time is what keeps an unguarded add from ever being authored.
      if (!edit.childLabel) {
        return {
          ok: false,
          error:
            "name the layer in the template first — an unnamed node cannot be" +
            " guarded against being added twice",
        };
      }
      edit.node = stripElementIds(raw.node);
      edit.place = normalizePlace(raw.place, index);
    }
    if (raw.op === "rename") {
      const title = String(raw.title || "").trim();
      if (!title) return { ok: false, error: "a rename carries no new name" };
      edit.title = title;
    }

    edit.conditions = withAutoCondition(edit);
    return { ok: true, edit };
  };

  const structuralEdit = (preset) => (preset?.edits || [])[0] || null;

  // ONE structural edit per preset, and the second is refused rather than
  // replacing the first. Two structural edits in one preset can invalidate each
  // other's indices, and the honest fix is a second preset run afterwards — so
  // say that instead of silently dropping work the user just did.
  const mergeStructural = (preset, capture) => {
    const base = preset || makePreset("");
    const templateId = asPositiveInt(capture?.templateId);
    if (!templateId) return { ok: false, error: "capture carries no template id" };
    if (base.templateId && String(base.templateId) !== String(templateId)) {
      return {
        ok: false,
        error:
          `this preset is bound to template #${base.templateId}` +
          ` — captures must come from that template's editor`,
      };
    }
    const existing = structuralEdit(base);
    if (existing) {
      return {
        ok: false,
        error:
          `"${base.name}" already has a structural edit (${editLabel(existing)}).` +
          ` Remove it, or capture this one into a new preset and run them in order.`,
      };
    }
    const made = normalizeEdit(capture.edit);
    if (!made.ok) return { ok: false, error: made.error };

    return {
      ok: true,
      edit: made.edit,
      preset: {
        ...base,
        v: EDGE_PRESET_VERSION,
        templateId: String(templateId),
        templateTitle: capture.templateTitle || base.templateTitle || "",
        edits: [made.edit],
      },
    };
  };

  const removeEdit = (preset, editId) => ({
    ...preset,
    edits: (preset?.edits || []).filter((e) => e.id !== editId),
  });

  // The GUI edits place and conditions after capture; both go back through
  // normalizeEdit so a hand-built condition cannot enter the stored shape
  // unvalidated.
  const updateEdit = (preset, editId, patch) => {
    const at = (preset?.edits || []).findIndex((e) => e.id === editId);
    if (at < 0) return { ok: false, error: "no such edit" };
    const made = normalizeEdit({ ...preset.edits[at], ...patch });
    if (!made.ok) return { ok: false, error: made.error };
    const edits = preset.edits.slice();
    edits[at] = made.edit;
    return { ok: true, preset: { ...preset, edits } };
  };

  // --------------------------------------------------------------- matching

  // Does a page layer carrying `tag` hold an instance of the root this node was
  // captured from?
  //
  // The `root === null` case is the rule template-sync already follows: a bare
  // "#4821" predates the template having several roots, and a single-root
  // template accepts "#4821" and "#4821.1" interchangeably. Accepting it for
  // root 1 only is what keeps a preset off the wrong block of a kit.
  const tagMatchesNode = (tag, preset, node) => {
    if (!tag || !preset?.templateId) return false;
    if (String(tag.id) !== String(preset.templateId)) return false;
    const root = asPositiveInt(node?.root) || 1;
    if (tag.root === null || tag.root === undefined) return root === 1;
    return Number(tag.root) === root;
  };

  // ---------------------------------------------------------- files (import)

  // Import is tolerant, export is canonical — the same contract animation
  // presets ship with, and for the same reason: stripping something by hand out
  // of an exported file must not make it unimportable, while an unknown or
  // malformed piece has to be *reported* rather than kept, because a typo is
  // otherwise indistinguishable from a field that had no effect.
  const parsePresetFile = (raw) => {
    const problems = [];
    let data = raw;
    if (typeof raw === "string") {
      try {
        data = JSON.parse(raw);
      } catch (e) {
        return { ok: false, error: `not valid JSON — ${e?.message || e}` };
      }
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "expected a JSON object" };
    }
    const version = Number(data.v ?? EDGE_PRESET_VERSION);
    if (Number.isFinite(version) && version > EDGE_PRESET_VERSION) {
      return {
        ok: false,
        error: `written by a newer build (v${version}, this build reads v${EDGE_PRESET_VERSION})`,
      };
    }

    const templateId = asPositiveInt(data.templateId);
    if (!templateId) {
      return { ok: false, error: "no templateId — a preset must name its template" };
    }

    const nodes = [];
    const rawNodes = Array.isArray(data.nodes) ? data.nodes : [];
    rawNodes.forEach((n, i) => {
      const where = `node ${i + 1}`;
      const root = asPositiveInt(n?.root) || 1;
      const path = Array.isArray(n?.path) ? n.path.map(Number) : null;
      if (!path || !path.every(isInt)) {
        problems.push(`${where}: path must be a list of child indices`);
        return;
      }
      const fields = [];
      for (const f of Array.isArray(n.fields) ? n.fields : []) {
        if (!f || !FIELD_SCOPES.has(f.scope)) {
          problems.push(`${where}: field has no recognised scope`);
          continue;
        }
        if (f.scope === "field" && !f.control) {
          problems.push(`${where}: field capture names no control`);
          continue;
        }
        if (f.scope === "section" && !f.section) {
          problems.push(`${where}: section capture names no section`);
          continue;
        }
        if (!f.values || typeof f.values !== "object") {
          problems.push(`${where}: ${fieldLabel(f)} carries no values`);
          continue;
        }
        fields.push(
          f.scope === "section"
            ? {
                scope: "section",
                section: String(f.section),
                label: f.label || String(f.section),
                values: f.values,
              }
            : {
                scope: "field",
                control: String(f.control),
                label: f.label || String(f.control),
                type: f.type || null,
                responsive: !!f.responsive,
                values: f.values,
              },
        );
      }
      if (!fields.length) {
        problems.push(`${where}: no usable fields — dropped`);
        return;
      }
      nodes.push({
        root,
        path,
        elType: n.elType || null,
        widgetType: n.widgetType || null,
        label: n.label || "",
        fields,
      });
    });

    // Only the first survives, and anything past it is reported rather than
    // dropped in silence — a hand-edited file with two is a file whose author
    // expected both to run.
    const edits = [];
    const rawEdits = Array.isArray(data.edits) ? data.edits : [];
    rawEdits.forEach((e, i) => {
      if (edits.length) {
        problems.push(
          `edit ${i + 1}: a preset carries one structural edit — dropped`,
        );
        return;
      }
      const made = normalizeEdit(e);
      if (!made.ok) problems.push(`edit ${i + 1}: ${made.error}`);
      else edits.push(made.edit);
    });

    if (!nodes.length && !edits.length) {
      return {
        ok: false,
        error: "no usable nodes or edits in the file",
        problems,
      };
    }

    return {
      ok: true,
      problems,
      preset: {
        v: EDGE_PRESET_VERSION,
        // A file with no id is imported as a new preset rather than rejected.
        id: typeof data.id === "string" && data.id ? data.id : newPresetId(),
        name: String(data.name || "").trim() || "Imported edge preset",
        templateId: String(templateId),
        templateTitle: data.templateTitle || "",
        nodes,
        edits,
      },
    };
  };

  const toPresetFile = (preset) => ({
    v: EDGE_PRESET_VERSION,
    id: preset?.id || newPresetId(),
    name: preset?.name || "",
    templateId: preset?.templateId ? String(preset.templateId) : null,
    templateTitle: preset?.templateTitle || "",
    nodes: (preset?.nodes || []).map((n) => ({
      root: asPositiveInt(n.root) || 1,
      path: (n.path || []).slice(),
      elType: n.elType || null,
      widgetType: n.widgetType || null,
      label: n.label || "",
      fields: (n.fields || []).map((f) => ({ ...f })),
    })),
    edits: (preset?.edits || []).map((e) => ({
      ...e,
      path: (e.path || []).slice(),
      conditions: (e.conditions || []).map((c) => ({ ...c })),
    })),
  });

  const exportFileName = (preset) => {
    const slug = String(preset?.name || "edge-preset")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    return `${slug || "edge-preset"}.edge-preset.json`;
  };

  window.__EdgePresetFormat = {
    EDGE_PRESET_VERSION,
    STORAGE_KEY,
    FIELD_SCOPES,
    newPresetId,
    makePreset,
    nodeKey,
    nodeSignature,
    pathLabel,
    fieldKey,
    fieldLabel,
    valueCount,
    describePreset,
    mergeCapture,
    removeNode,
    removeField,
    EDIT_OPS,
    PLACE_MODES,
    CONDITION_KINDS,
    COMPARATORS,
    newEditId,
    editParentKey,
    editSignature,
    editLabel,
    conditionLabel,
    normalizeCondition,
    normalizeEdit,
    stripElementIds,
    structuralEdit,
    mergeStructural,
    removeEdit,
    updateEdit,
    tagMatchesNode,
    parsePresetFile,
    toPresetFile,
    exportFileName,
  };
})();
