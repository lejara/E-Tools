// The Motion Effects tab, as data. Dual-context: the panel builds and validates
// preset files with it, the editor turns a preset into a write. Must not touch
// `location` or the DOM at load time.
//
// The field list is a snapshot of Elementor's `section_effects`, captured from
// Elementor Pro on 2026-07-31 — 65 controls, of which 61 are real settings. It
// is hardcoded on purpose: the whole point of a preset file is that a human
// reads and edits it, and a comment derived at runtime cannot be reviewed before
// it ships. Re-diff it against `container.settings.controls` after an Elementor
// upgrade; anything new simply goes unmanaged until it is added here.
//
// What is NOT hardcoded is the key each field resolves to on a given element.
// Widgets prefix *some* advanced controls with an underscore and containers do
// not, and it is not a rule you can encode: a widget carries `_animation` and
// `_animation_delay` but plain `animation_duration`. Every key below is the
// container spelling, and `apply-preset-settings` resolves it against the
// target's own control list. A hardcoded prefix table would write
// `animation_delay` onto a widget, where the real key is `_animation_delay`, and
// the value would land nowhere with nothing raised.
(() => {
  // Four of the section's 65 controls are not settings and are deliberately
  // absent below: `ai_animation` (a raw_html "Animate With AI" button),
  // `handle_motion_fx_asset_loading` (hidden bookkeeping Elementor maintains),
  // `anchor_offset_description` (raw_html help text) and `sticky_divider`.
  const SCROLL_ON = 'Needs motion_fx_motion_fx_scrolling = "yes".';
  const MOUSE_ON = 'Needs motion_fx_motion_fx_mouse = "yes".';
  const DIR_NEG = '"" = default direction, "negative" = reversed.';
  const DIR_4 =
    'One of "out-in", "in-out", "in-out-in", "out-in-out" — where in the viewport the effect runs.';
  const DEVICES =
    'Array of breakpoints, any of "desktop", "tablet_extra", "tablet", "mobile_extra", "mobile". An empty array means nowhere.';

  // Sliders are objects, not numbers. Writing `4` puts garbage in the model.
  const speed = (unit, lo, hi, step) =>
    `Slider object, NOT a number — {"size":4,"unit":"${unit}","sizes":[]}. ` +
    `${unit} range ${lo}–${hi} step ${step}. Higher is faster.`;
  const level = (unit, lo, hi, step) =>
    `Slider object, NOT a number — {"size":7,"unit":"${unit}","sizes":[]}. ` +
    `${unit} range ${lo}–${hi} step ${step}.`;
  const viewport =
    'Viewport range object — {"size":"","unit":"%","sizes":{"start":0,"end":100}}. ' +
    "start/end are percentages of the scroll pass over which the effect plays.";

  const ANIMATIONS =
    '"" = Default (whatever the theme does), "none", or one of: ' +
    "fadeIn fadeInDown fadeInLeft fadeInRight fadeInUp · " +
    "zoomIn zoomInDown zoomInLeft zoomInRight zoomInUp · " +
    "bounceIn bounceInDown bounceInLeft bounceInRight bounceInUp · " +
    "slideInDown slideInLeft slideInRight slideInUp · " +
    "rotateIn rotateInDownLeft rotateInDownRight rotateInUpLeft rotateInUpRight · " +
    "bounce flash pulse rubberBand shake headShake swing tada wobble jello · " +
    "lightSpeedIn · rollIn";

  const sliderDef = (size, unit) => ({ size, sizes: [], unit });
  const rangeDef = (start, end) => ({
    size: "",
    sizes: { start, end },
    unit: "%",
  });
  const ALL_DEVICES = [
    "desktop",
    "tablet_extra",
    "tablet",
    "mobile_extra",
    "mobile",
  ];

  const FIELDS = [
    // ---- Scrolling Effects ------------------------------------------------
    {
      key: "motion_fx_motion_fx_scrolling",
      type: "switcher",
      def: "",
      comment:
        'Master switch for every scroll effect below. "yes" to enable, "" to disable.',
    },
    {
      key: "motion_fx_translateY_effect",
      type: "popover_toggle",
      def: "",
      comment: `Vertical Scroll. "yes" enables, "" disables. ${SCROLL_ON}`,
    },
    {
      key: "motion_fx_translateY_direction",
      type: "select",
      def: "",
      comment: `Vertical Scroll direction — "" = down, "negative" = up.`,
    },
    {
      key: "motion_fx_translateY_speed",
      type: "slider",
      def: sliderDef(4, "px"),
      comment: speed("px", 0, 10, 0.1),
    },
    {
      key: "motion_fx_translateY_affectedRange",
      type: "slider",
      def: rangeDef(0, 100),
      comment: viewport,
    },
    {
      key: "motion_fx_translateX_effect",
      type: "popover_toggle",
      def: "",
      comment: `Horizontal Scroll. "yes" enables, "" disables. ${SCROLL_ON}`,
    },
    {
      key: "motion_fx_translateX_direction",
      type: "select",
      def: "",
      comment: 'Horizontal Scroll direction — "" = right, "negative" = left.',
    },
    {
      key: "motion_fx_translateX_speed",
      type: "slider",
      def: sliderDef(4, "px"),
      comment: speed("px", 0, 10, 0.1),
    },
    {
      key: "motion_fx_translateX_affectedRange",
      type: "slider",
      def: rangeDef(0, 100),
      comment: viewport,
    },
    {
      key: "motion_fx_opacity_effect",
      type: "popover_toggle",
      def: "",
      comment: `Transparency. "yes" enables, "" disables. ${SCROLL_ON}`,
    },
    {
      key: "motion_fx_opacity_direction",
      type: "select",
      def: "out-in",
      comment: `Transparency direction. ${DIR_4}`,
    },
    {
      key: "motion_fx_opacity_level",
      type: "slider",
      def: sliderDef(10, "px"),
      comment: level("px", 1, 10, 0.1) + " 10 fades fully, 1 barely at all.",
    },
    {
      key: "motion_fx_opacity_range",
      type: "slider",
      def: rangeDef(20, 80),
      comment: viewport,
    },
    {
      key: "motion_fx_blur_effect",
      type: "popover_toggle",
      def: "",
      comment: `Blur. "yes" enables, "" disables. ${SCROLL_ON}`,
    },
    {
      key: "motion_fx_blur_direction",
      type: "select",
      def: "out-in",
      comment: `Blur direction. ${DIR_4}`,
    },
    {
      key: "motion_fx_blur_level",
      type: "slider",
      def: sliderDef(7, "px"),
      comment: level("px", 1, 15, 1),
    },
    {
      key: "motion_fx_blur_range",
      type: "slider",
      def: rangeDef(20, 80),
      comment: viewport,
    },
    {
      key: "motion_fx_rotateZ_effect",
      type: "popover_toggle",
      def: "",
      comment: `Rotate. "yes" enables, "" disables. ${SCROLL_ON}`,
    },
    {
      key: "motion_fx_rotateZ_direction",
      type: "select",
      def: "",
      comment: `Rotate direction. ${DIR_NEG}`,
    },
    {
      key: "motion_fx_rotateZ_speed",
      type: "slider",
      def: sliderDef(1, "px"),
      comment: speed("px", 0, 10, 0.1),
    },
    {
      key: "motion_fx_rotateZ_affectedRange",
      type: "slider",
      def: rangeDef(0, 100),
      comment: viewport,
    },
    {
      key: "motion_fx_scale_effect",
      type: "popover_toggle",
      def: "",
      comment: `Scale. "yes" enables, "" disables. ${SCROLL_ON}`,
    },
    {
      key: "motion_fx_scale_direction",
      type: "select",
      def: "out-in",
      comment: `Scale direction. ${DIR_4}`,
    },
    {
      key: "motion_fx_scale_speed",
      type: "slider",
      def: sliderDef(4, "px"),
      comment: speed("px", -10, 10, 1) + " Negative shrinks instead of grows.",
    },
    {
      key: "motion_fx_scale_range",
      type: "slider",
      def: rangeDef(20, 80),
      comment: viewport,
    },
    {
      key: "motion_fx_transform_origin_x",
      type: "choose",
      def: "center",
      comment:
        'X anchor point for Rotate and Scale — "left", "center" or "right".',
    },
    {
      key: "motion_fx_transform_origin_y",
      type: "choose",
      def: "center",
      comment:
        'Y anchor point for Rotate and Scale — "top", "center" or "bottom".',
    },
    {
      key: "motion_fx_devices",
      type: "select2",
      def: [...ALL_DEVICES],
      comment: `Which breakpoints run the scroll effects. ${DEVICES}`,
    },
    {
      key: "motion_fx_range",
      type: "select",
      def: "",
      comment:
        'What the effect is measured against — "" = default, "viewport", or "page".',
    },

    // ---- Mouse Effects ----------------------------------------------------
    {
      key: "motion_fx_motion_fx_mouse",
      type: "switcher",
      def: "",
      comment:
        'Master switch for the two mouse effects below. "yes" to enable, "" to disable.',
    },
    {
      key: "motion_fx_mouseTrack_effect",
      type: "popover_toggle",
      def: "",
      comment: `Mouse Track. "yes" enables, "" disables. ${MOUSE_ON}`,
    },
    {
      key: "motion_fx_mouseTrack_direction",
      type: "select",
      def: "",
      comment: `Mouse Track direction. ${DIR_NEG}`,
    },
    {
      key: "motion_fx_mouseTrack_speed",
      type: "slider",
      def: sliderDef(1, "px"),
      comment: speed("px", 0, 10, 0.1),
    },
    {
      key: "motion_fx_tilt_effect",
      type: "popover_toggle",
      def: "",
      comment: `3D Tilt. "yes" enables, "" disables. ${MOUSE_ON}`,
    },
    {
      key: "motion_fx_tilt_direction",
      type: "select",
      def: "",
      comment: `3D Tilt direction. ${DIR_NEG}`,
    },
    {
      key: "motion_fx_tilt_speed",
      type: "slider",
      def: sliderDef(4, "px"),
      comment: speed("px", 0, 10, 0.1),
    },

    // ---- Sticky -----------------------------------------------------------
    {
      key: "sticky",
      type: "select",
      def: "",
      comment: 'Stick to "top" or "bottom". "" is not sticky.',
    },
    {
      key: "sticky_on",
      type: "select2",
      def: [...ALL_DEVICES],
      comment: `Which breakpoints stick. ${DEVICES}`,
    },
    {
      key: "sticky_offset",
      type: "number",
      def: 0,
      comment: "Distance in px from the edge it sticks to. Number.",
    },
    {
      key: "sticky_offset_tablet_extra",
      type: "number",
      def: "",
      comment: 'Sticky Offset on Tablet Extra. Number, or "" to inherit.',
    },
    {
      key: "sticky_offset_tablet",
      type: "number",
      def: "",
      comment: 'Sticky Offset on Tablet. Number, or "" to inherit.',
    },
    {
      key: "sticky_offset_mobile_extra",
      type: "number",
      def: "",
      comment: 'Sticky Offset on Mobile Extra. Number, or "" to inherit.',
    },
    {
      key: "sticky_offset_mobile",
      type: "number",
      def: "",
      comment: 'Sticky Offset on Mobile. Number, or "" to inherit.',
    },
    {
      key: "sticky_effects_offset",
      type: "number",
      def: 0,
      comment:
        "How far past the sticky point before scroll effects start, in px. Number.",
    },
    {
      key: "sticky_effects_offset_tablet_extra",
      type: "number",
      def: "",
      comment: 'Effects Offset on Tablet Extra. Number, or "" to inherit.',
    },
    {
      key: "sticky_effects_offset_tablet",
      type: "number",
      def: "",
      comment: 'Effects Offset on Tablet. Number, or "" to inherit.',
    },
    {
      key: "sticky_effects_offset_mobile_extra",
      type: "number",
      def: "",
      comment: 'Effects Offset on Mobile Extra. Number, or "" to inherit.',
    },
    {
      key: "sticky_effects_offset_mobile",
      type: "number",
      def: "",
      comment: 'Effects Offset on Mobile. Number, or "" to inherit.',
    },
    {
      key: "sticky_anchor_link_offset",
      type: "number",
      def: 0,
      comment:
        "Extra px an anchor link leaves above this element while sticky. Number.",
    },
    {
      key: "sticky_anchor_link_offset_tablet_extra",
      type: "number",
      def: "",
      comment: 'Anchor Offset on Tablet Extra. Number, or "" to inherit.',
    },
    {
      key: "sticky_anchor_link_offset_tablet",
      type: "number",
      def: "",
      comment: 'Anchor Offset on Tablet. Number, or "" to inherit.',
    },
    {
      key: "sticky_anchor_link_offset_mobile_extra",
      type: "number",
      def: "",
      comment: 'Anchor Offset on Mobile Extra. Number, or "" to inherit.',
    },
    {
      key: "sticky_anchor_link_offset_mobile",
      type: "number",
      def: "",
      comment: 'Anchor Offset on Mobile. Number, or "" to inherit.',
    },
    {
      key: "sticky_parent",
      type: "switcher",
      def: "",
      comment:
        '"yes" keeps it stuck only while its parent is on screen. "" lets it stick for the whole page.',
    },

    // ---- Entrance Animation ----------------------------------------------
    {
      key: "animation",
      type: "animation",
      def: "",
      comment: `Entrance animation. ${ANIMATIONS}`,
    },
    {
      key: "animation_tablet_extra",
      type: "animation",
      def: "",
      comment: "Entrance animation on Tablet Extra. Same values as `animation`.",
    },
    {
      key: "animation_tablet",
      type: "animation",
      def: "",
      comment: "Entrance animation on Tablet. Same values as `animation`.",
    },
    {
      key: "animation_mobile_extra",
      type: "animation",
      def: "",
      comment: "Entrance animation on Mobile Extra. Same values as `animation`.",
    },
    {
      key: "animation_mobile",
      type: "animation",
      def: "",
      comment: "Entrance animation on Mobile. Same values as `animation`.",
    },
    {
      key: "animation_duration",
      type: "select",
      def: "",
      comment: '"slow", "" (normal) or "fast".',
    },
    {
      key: "animation_delay",
      type: "number",
      def: "",
      comment:
        "Delay before the entrance animation, in ms. Number. This is the field " +
        "Delay Accumulation adds to — with several layers shift-clicked, layer N " +
        "gets this value plus (accumulation × (N-1)).",
    },
  ];

  const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

  // The one field Delay Accumulation touches. Named here so the editor side and
  // the panel's hint cannot disagree about which it is.
  const DELAY_KEY = "animation_delay";

  // Key order must not count. A slider value is an object — {size, unit, sizes}
  // — and Elementor writes those keys in a different order than this file does,
  // so a plain JSON.stringify comparison calls an untouched default "changed"
  // and writes it back. Harmless, but it makes a preset that sets nothing send a
  // 61-field message, and it makes "did the user actually change this?"
  // unanswerable from a hand-edited file.
  const canon = (v) => {
    if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
    if (v && typeof v === "object") {
      return `{${Object.keys(v)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
        .join(",")}}`;
    }
    return JSON.stringify(v);
  };
  const same = (a, b) => canon(a) === canon(b);

  const newPresetId = () =>
    // Short enough to read in a filename, wide enough that two people writing
    // presets on the same day do not collide.
    `ap_${Math.random().toString(36).slice(2, 8)}${Math.random()
      .toString(36)
      .slice(2, 6)}`;

  // A preset captured off a real element. Every field is present, defaults
  // included, because a preset describes the whole tab — applying it has to be
  // able to say "and this one is off", which an omitted key cannot.
  //
  // A key the element did not have falls back to the Elementor default rather
  // than being dropped, so a preset captured from a widget still carries the
  // fields only a container has and stays applicable to either.
  const presetFromValues = (values, name) => {
    const held = new Map((values || []).map((v) => [v.key, v.value]));
    return {
      id: newPresetId(),
      name: String(name || "").trim() || "Untitled preset",
      fields: Object.fromEntries(
        FIELDS.map((f) => [
          f.key,
          {
            comment: f.comment,
            value: held.has(f.key) ? held.get(f.key) : f.def,
          },
        ]),
      ),
    };
  };

  const stringifyPreset = (preset) => {
    // Re-attach the current comment text on the way out, so an exported preset
    // documents itself against this build rather than whatever it was imported
    // with. Unknown keys are dropped here too — they cannot be applied, so
    // carrying them would misrepresent what the file does.
    const fields = {};
    for (const f of FIELDS) {
      const held = preset.fields?.[f.key];
      if (held === undefined) continue;
      fields[f.key] = {
        comment: f.comment,
        value: held && typeof held === "object" && "value" in held
          ? held.value
          : held,
      };
    }
    return `${JSON.stringify({ id: preset.id, name: preset.name, fields }, null, 2)}\n`;
  };

  // Tolerant on the way in. A field may be {comment, value} or a bare value —
  // someone stripping the comments out by hand should not break their preset —
  // and an unknown key is reported rather than silently kept, because a typo in
  // a key is otherwise indistinguishable from a field that had no effect.
  const parsePreset = (text) => {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      return { ok: false, error: `Not valid JSON — ${err.message}` };
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: "Expected a single preset object" };
    }
    if (!raw.fields || typeof raw.fields !== "object") {
      return { ok: false, error: 'Missing a "fields" object' };
    }

    const warnings = [];
    const fields = {};
    for (const [key, held] of Object.entries(raw.fields)) {
      const def = BY_KEY.get(key);
      if (!def) {
        warnings.push(`unknown field "${key}" ignored`);
        continue;
      }
      const value =
        held && typeof held === "object" && "value" in held ? held.value : held;
      fields[key] = { comment: def.comment, value };
    }
    if (!Object.keys(fields).length) {
      return { ok: false, error: "No recognised Motion Effects fields in that file" };
    }

    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
    if (!id) warnings.push("no id in the file — imported as a new preset");
    const name =
      typeof raw.name === "string" && raw.name.trim()
        ? raw.name.trim()
        : "Untitled preset";

    return {
      ok: true,
      preset: { id: id || newPresetId(), name, fields },
      generatedId: !id,
      warnings,
    };
  };

  // What actually gets written, after the reset has already put the whole tab
  // back to defaults. A field left at its default is dropped: the reset covered
  // it, so writing it again is a longer message for the same document.
  const presetWrites = (preset) => {
    const out = [];
    for (const f of FIELDS) {
      const held = preset.fields?.[f.key];
      if (held === undefined) continue;
      const value =
        held && typeof held === "object" && "value" in held ? held.value : held;
      if (value === undefined || same(value, f.def)) continue;
      out.push({ key: f.key, type: f.type, value });
    }
    return out;
  };

  const presetDelay = (preset) => {
    const held = preset.fields?.[DELAY_KEY];
    const value =
      held && typeof held === "object" && "value" in held ? held.value : held;
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };

  window.__AnimationPresetFields = {
    FIELDS,
    ALL_KEYS: FIELDS.map((f) => f.key),
    DELAY_KEY,
    newPresetId,
    presetFromValues,
    stringifyPreset,
    parsePreset,
    presetWrites,
    presetDelay,
  };
})();
