import React, { useEffect, useState } from "react";
import { applySkin, parseSkin, readSkin, skinOptions, skinStorageKey } from "./skin";

export function SkinPicker() {
  const [skin, setSkin] = useState(readSkin);
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === skinStorageKey) { const next = parseSkin(event.newValue); setSkin(next); applySkin(next, false); } };
    window.addEventListener("storage", sync); return () => window.removeEventListener("storage", sync);
  }, []);
  return <fieldset className="skin-picker"><legend>窗外的风景</legend><p>水边、车站、湖畔。选一处喜欢的地方。</p><div className="skin-options">
    {skinOptions.map((item) => <label key={item.id} className={`skin-choice ${skin === item.id ? "selected" : ""}`}>
      <input type="radio" name="skin" value={item.id} checked={skin === item.id} onChange={() => { setSkin(item.id); applySkin(item.id); }} />
      <span className={`skin-swatch skin-swatch-${item.id}`} aria-hidden="true" /><span>{item.label}</span>
    </label>)}
  </div></fieldset>;
}
