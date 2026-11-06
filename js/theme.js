// Light, dark or system theme for the extension pages. Loaded in <head> so the
// theme is set before the first paint. The choice is kept in localStorage,
// which all extension pages share, and open pages follow a change at once.
(function () {
  const KEY = "mcp-theme";
  const MODES = ["system", "light", "dark"];
  const media = window.matchMedia("(prefers-color-scheme: dark)");

  function read() {
    try {
      const value = localStorage.getItem(KEY);
      return MODES.includes(value) ? value : "system";
    } catch (_) {
      return "system";
    }
  }

  function isDark(mode) {
    const m = mode || read();
    return m === "dark" || (m === "system" && media.matches);
  }

  function apply(mode) {
    const root = document.documentElement;
    if (mode === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", mode);
    document.querySelectorAll(".theme-switch button").forEach((b) =>
      b.setAttribute("aria-checked", String(b.dataset.themeMode === mode))
    );
    document.dispatchEvent(new CustomEvent("mcp-themechange", { detail: { mode, dark: isDark(mode) } }));
  }

  function set(mode) {
    const next = MODES.includes(mode) ? mode : "system";
    try {
      localStorage.setItem(KEY, next);
    } catch (_) {}
    apply(next);
  }

  const ICONS = {
    system:
      '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="9" rx="1.5"/><path d="M5.5 14h5M8 11.5V14"/></svg>',
    light:
      '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1"/></svg>',
    dark: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z"/></svg>',
  };
  const LABELS = { system: "System", light: "Light", dark: "Dark" };

  /** Fill every [data-theme-switch] placeholder with the switch. */
  function mount() {
    document.querySelectorAll("[data-theme-switch]").forEach((host) => {
      host.className = "seg theme-switch";
      host.setAttribute("role", "radiogroup");
      host.setAttribute("aria-label", "Theme");
      host.innerHTML = MODES.map(
        (m) =>
          `<button type="button" role="radio" data-theme-mode="${m}" title="${LABELS[m]} theme" aria-label="${LABELS[m]} theme">${ICONS[m]}</button>`
      ).join("");
      host.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-theme-mode]");
        if (btn) set(btn.dataset.themeMode);
      });
    });
    apply(read());
  }

  apply(read());
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();

  // Another extension page changed it.
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) apply(read());
  });
  // The system theme changed: matters only in System mode.
  media.addEventListener("change", () => {
    if (read() === "system") apply("system");
  });

  window.mcpTheme = { get: read, set, isDark: () => isDark() };
})();
