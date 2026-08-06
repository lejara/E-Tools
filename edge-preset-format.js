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
(() => {
  // Bump when the stored shape changes. A file from a newer build is refused
  // rather than half-read, the same call INDEX_VERSION makes for the usage
  // cache: reading a shape you only partly understand writes wrong values into
  // real pages, and here there is no scan to re-earn it from.
  const EDGE_PRESET_VERSION = 1;

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
    return { nodes, fields, values };
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

    if (!nodes.length) {
      return {
        ok: false,
        error: "no usable nodes in the file",
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
    tagMatchesNode,
    parsePresetFile,
    toPresetFile,
    exportFileName,
  };
})();
