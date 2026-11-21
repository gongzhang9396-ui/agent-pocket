export const skinOptions = [
  { id: "plain", label: "澄明", description: "清爽、克制，适合长时间使用" },
  { id: "pixel", label: "像素", description: "复古掌机，保留清晰的操作感" },
  { id: "oil", label: "油画", description: "纸色与森林绿，像一本工作手记" },
] as const;

export const appearanceOptions = [
  { id: "light", label: "浅色" },
  { id: "dark", label: "深色" },
  { id: "system", label: "跟随系统" },
] as const;

export type Skin = typeof skinOptions[number]["id"];
export type Appearance = typeof appearanceOptions[number]["id"];
export type ResolvedAppearance = Exclude<Appearance, "system">;

export const skinStorageKey = "agent-pocket-appearance-v1";
export const appearanceStorageKey = "agent-pocket-color-mode-v1";

export function parseSkin(value: unknown): Skin {
  return skinOptions.some((item) => item.id === value) ? value as Skin : "plain";
}

export function parseAppearance(value: unknown): Appearance {
  return appearanceOptions.some((item) => item.id === value) ? value as Appearance : "light";
}

export function readSkin(): Skin {
  try { return parseSkin(localStorage.getItem(skinStorageKey)); } catch { return "plain"; }
}

export function readAppearance(): Appearance {
  try { return parseAppearance(localStorage.getItem(appearanceStorageKey)); } catch { return "light"; }
}

export function resolveAppearance(value: Appearance): ResolvedAppearance {
  if (value !== "system") return value;
  try { return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; }
  catch { return "light"; }
}

const themeColors: Record<Skin, Record<ResolvedAppearance, string>> = {
  plain: { light: "#f2f5f7", dark: "#111820" },
  pixel: { light: "#e7edf0", dark: "#101a23" },
  oil: { light: "#ede8dc", dark: "#20241f" },
};

let activeAppearance: Appearance = "light";
let watchingSystem = false;
let watchingStorage = false;

function watchSystemAppearance() {
  if (watchingSystem || typeof window === "undefined") return;
  try {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => { if (activeAppearance === "system") applyAppearance("system", false); };
    if (typeof query.addEventListener === "function") query.addEventListener("change", listener);
    else query.addListener(listener);
    watchingSystem = true;
  } catch { /* Older embedded browsers can keep the initial resolved mode. */ }
}

function watchAppearanceStorage() {
  if (watchingStorage || typeof window === "undefined") return;
  watchingStorage = true;
  window.addEventListener("storage", (event) => {
    if (event.key === skinStorageKey) applySkin(parseSkin(event.newValue), false);
    if (event.key === appearanceStorageKey) applyAppearance(parseAppearance(event.newValue), false);
  });
}

export function applyAppearance(value: Appearance, save = true) {
  const preference = parseAppearance(value);
  activeAppearance = preference;
  const resolved = resolveAppearance(preference);
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.dataset.appearance = preference;
    root.dataset.mode = resolved;
    root.style.colorScheme = resolved;
    const skin = parseSkin(root.dataset.skin);
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", themeColors[skin][resolved]);
  }
  if (save) { try { localStorage.setItem(appearanceStorageKey, preference); } catch { /* private browsing */ } }
  watchSystemAppearance();
  watchAppearanceStorage();
}

export function applySkin(value: Skin, save = true) {
  const skin = parseSkin(value);
  if (save) { try { localStorage.setItem(skinStorageKey, skin); } catch { /* private browsing */ } }
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.dataset.skin = skin;
    // The current DOM preference also works when localStorage is unavailable.
    applyAppearance(parseAppearance(root.dataset.appearance || readAppearance()), false);
  } else applyAppearance(readAppearance(), false);
}
