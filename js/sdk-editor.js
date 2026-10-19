/**
 * Code editor for SDK Tools > Edit. Uses Ace (vendor/ace) with JavaScript
 * syntax checking; falls back to a plain textarea if Ace failed to load.
 * Exposes the small surface settings.js needs: value, input events, focus,
 * gotoLine and syntax errors.
 */
(function () {
  function createSdkEditor(host) {
    const inputListeners = [];
    const errorListeners = [];
    const emit = (list, arg) => list.forEach((fn) => fn(arg));

    if (!window.ace) {
      const area = document.createElement("textarea");
      area.className = "st-editor-fallback mono";
      area.spellcheck = false;
      area.placeholder = "Load an SDK to begin editing.";
      host.appendChild(area);
      area.addEventListener("input", () => emit(inputListeners));
      return {
        get value() {
          return area.value;
        },
        set value(text) {
          area.value = String(text || "");
        },
        addEventListener(type, fn) {
          if (type === "input") inputListeners.push(fn);
          if (type === "errors") errorListeners.push(fn);
        },
        errors: () => [],
        gotoLine() {
          area.focus();
        },
      };
    }

    window.ace.config.set("basePath", chrome.runtime.getURL("vendor/ace"));
    // The extension CSP (script-src 'self') blocks Ace's default blob worker.
    window.ace.config.set("loadWorkerFromBlob", false);
    // Ace takes over its element; the host keeps the border and resize handle.
    const inner = document.createElement("div");
    host.appendChild(inner);
    const editor = window.ace.edit(inner, {
      mode: "ace/mode/javascript",
      fontSize: "12px",
      showPrintMargin: false,
      tabSize: 2,
      useSoftTabs: true,
      wrap: false,
      placeholder: "Load an SDK to begin editing.",
    });

    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const setTheme = () =>
      editor.setTheme(dark.matches ? "ace/theme/tomorrow_night" : "ace/theme/tomorrow");
    setTheme();
    dark.addEventListener("change", setTheme);
    new ResizeObserver(() => editor.resize()).observe(host);

    // Set while value is assigned from code, so loads don't count as edits.
    let settingValue = false;
    editor.session.on("change", () => {
      if (!settingValue) emit(inputListeners);
    });

    const errors = () =>
      (editor.session.getAnnotations() || [])
        .filter((a) => a.type === "error")
        .map((a) => ({ line: a.row + 1, column: a.column + 1, text: a.text }));
    editor.session.on("changeAnnotation", () => emit(errorListeners, errors()));

    return {
      get value() {
        return editor.getValue();
      },
      set value(text) {
        settingValue = true;
        try {
          // setValue on the session also resets undo history.
          editor.session.setValue(String(text || ""));
        } finally {
          settingValue = false;
        }
      },
      addEventListener(type, fn) {
        if (type === "input") inputListeners.push(fn);
        if (type === "errors") errorListeners.push(fn);
      },
      errors,
      gotoLine(line, column) {
        editor.gotoLine(line, Math.max(0, (column || 1) - 1), true);
        editor.focus();
      },
      setWrap(on) {
        editor.session.setUseWrapMode(!!on);
      },
    };
  }

  window.createSdkEditor = createSdkEditor;
})();
