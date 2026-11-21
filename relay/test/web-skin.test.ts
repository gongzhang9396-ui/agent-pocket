import assert from "node:assert/strict";
import test from "node:test";
import { parseSkin, readSkin, applySkin, skinStorageKey } from "../web/src/skin.ts";

test("appearance accepts only known skins and persists without account data", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
  try {
    assert.equal(readSkin(), "plain"); assert.equal(parseSkin("unknown"), "plain");
    applySkin("pixel"); assert.equal(readSkin(), "pixel");
    applySkin("oil"); assert.equal(values.get(skinStorageKey), "oil");
    assert.deepEqual([...values.keys()], [skinStorageKey]);
  } finally { if (previous) Object.defineProperty(globalThis, "localStorage", previous); else delete (globalThis as any).localStorage; }
});
