import React, { useEffect, useState } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import {
  appearanceOptions,
  appearanceStorageKey,
  applyAppearance,
  applySkin,
  parseAppearance,
  parseSkin,
  readAppearance,
  readSkin,
  skinOptions,
  skinStorageKey,
} from "./skin";

export function SkinPicker() {
  const [skin, setSkin] = useState(readSkin);
  const [appearance, setAppearance] = useState(readAppearance);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === skinStorageKey) {
        const next = parseSkin(event.newValue);
        setSkin(next);
        applySkin(next, false);
      }
      if (event.key === appearanceStorageKey) {
        const next = parseAppearance(event.newValue);
        setAppearance(next);
        applyAppearance(next, false);
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  return <div className="appearance-picker">
    <fieldset className="skin-picker">
      <legend>界面风格</legend>
      <p>选择适合你的工作台，设置仅保存在这台设备。</p>
      <div className="skin-options">
        {skinOptions.map((item) => <label key={item.id} className={`skin-choice ${skin === item.id ? "selected" : ""}`}>
          <input type="radio" name="skin" value={item.id} checked={skin === item.id} onChange={() => { setSkin(item.id); applySkin(item.id); }} />
          <span className={`skin-swatch skin-swatch-${item.id}`} aria-hidden="true">
            <span className="swatch-rail"><i /><i /><i /></span>
            <span className="swatch-content"><b>{item.id === "pixel" ? ">_" : "Aa"}</b><i /><i /><em /></span>
            {skin === item.id && <span className="swatch-check"><Check size={11} strokeWidth={3} /></span>}
          </span>
          <span className="skin-choice-label">{item.label}<small>{item.description}</small></span>
        </label>)}
      </div>
    </fieldset>
    <fieldset className="mode-picker">
      <legend>明暗模式</legend>
      <div className="mode-options">
        {appearanceOptions.map((item) => <label key={item.id} className={`mode-choice ${appearance === item.id ? "selected" : ""}`}>
          <input type="radio" name="color-mode" value={item.id} checked={appearance === item.id} onChange={() => { setAppearance(item.id); applyAppearance(item.id); }} />
          {item.id === "light" ? <Sun size={16} /> : item.id === "dark" ? <Moon size={16} /> : <Monitor size={16} />}
          <span>{item.label}</span>
        </label>)}
      </div>
    </fieldset>
  </div>;
}
