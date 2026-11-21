(() => {
  const root = document.documentElement;
  const colors = {
    plain: { light: "#f2f5f7", dark: "#111820" },
    pixel: { light: "#e7edf0", dark: "#101a23" },
    oil: { light: "#ede8dc", dark: "#20241f" },
  };
  let skin = "plain";
  let preference = "light";
  try {
    const savedSkin = localStorage.getItem("agent-pocket-appearance-v1");
    const savedMode = localStorage.getItem("agent-pocket-color-mode-v1");
    if (["plain", "pixel", "oil"].includes(savedSkin)) skin = savedSkin;
    if (["light", "dark", "system"].includes(savedMode)) preference = savedMode;
  } catch { /* Storage can be unavailable in private browsing. */ }
  let dark = preference === "dark";
  if (preference === "system") {
    try { dark = window.matchMedia("(prefers-color-scheme: dark)").matches; } catch { dark = false; }
  }
  const mode = dark ? "dark" : "light";
  root.dataset.skin = skin;
  root.dataset.appearance = preference;
  root.dataset.mode = mode;
  root.style.colorScheme = mode;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", colors[skin][mode]);
})();
