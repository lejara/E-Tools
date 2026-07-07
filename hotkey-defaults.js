(() => {
  const ACTIONS = [
    {
      id: "findLayerRoot",
      label: "Capture root layer",
      default: { ctrl: true, shift: true, alt: false, code: "Digit1" },
    },
    {
      id: "replaceStyles",
      label: "Replace styles",
      default: { ctrl: true, shift: true, alt: false, code: "Digit2" },
    },
    {
      id: "replaceLayer",
      label: "Replace layer",
      default: { ctrl: true, shift: true, alt: false, code: "Digit3" },
    },
    {
      id: "batchRename",
      label: "Batch rename",
      default: { ctrl: true, shift: true, alt: false, code: "Digit4" },
    },
    {
      id: "reselectRoot",
      label: "Reselect stored root",
      default: { ctrl: true, shift: true, alt: false, code: "Digit5" },
    },
  ];

  const formatKey = (code) => {
    if (!code) return "";
    if (code.startsWith("Digit")) return code.slice(5);
    if (code.startsWith("Key")) return code.slice(3);
    if (code.startsWith("Numpad")) return "Num" + code.slice(6);
    if (code.startsWith("Arrow")) return code.slice(5);
    return code;
  };

  const formatBinding = (b) => {
    if (!b || !b.code) return "Unbound";
    const parts = [];
    if (b.ctrl) parts.push("Ctrl");
    if (b.shift) parts.push("Shift");
    if (b.alt) parts.push("Alt");
    parts.push(formatKey(b.code));
    return parts.join("+");
  };

  const matches = (b, e) => {
    if (!b || !b.code) return false;
    if (!!b.ctrl !== !!(e.ctrlKey || e.metaKey)) return false;
    if (!!b.shift !== e.shiftKey) return false;
    if (!!b.alt !== e.altKey) return false;
    return e.code === b.code;
  };

  const bindingKey = (b) =>
    b && b.code
      ? `${b.ctrl ? 1 : 0}${b.shift ? 1 : 0}${b.alt ? 1 : 0}:${b.code}`
      : "";

  const mergeWithDefaults = (stored) => {
    const out = {};
    for (const a of ACTIONS) {
      out[a.id] =
        stored && Object.prototype.hasOwnProperty.call(stored, a.id)
          ? stored[a.id]
          : a.default;
    }
    return out;
  };

  window.__ElementorHotkeyDefaults = {
    ACTIONS,
    formatKey,
    formatBinding,
    matches,
    bindingKey,
    mergeWithDefaults,
  };
})();
