export const skinOptions = [
  { id: "plain", label: "纸间" },
  { id: "pixel", label: "像素" },
  { id: "oil", label: "画室" },
] as const;
export type Skin = typeof skinOptions[number]["id"];
export const skinStorageKey = "agent-pocket-appearance-v1";

export function parseSkin(value: unknown): Skin {
  return skinOptions.some((item) => item.id === value) ? value as Skin : "plain";
}
export function readSkin(): Skin {
  try { return parseSkin(localStorage.getItem(skinStorageKey)); } catch { return "plain"; }
}
export function applySkin(value: Skin, save = true) {
  if (typeof document !== "undefined") document.documentElement.dataset.skin = parseSkin(value);
  if (save) { try { localStorage.setItem(skinStorageKey, value); } catch { /* private browsing */ } }
}
