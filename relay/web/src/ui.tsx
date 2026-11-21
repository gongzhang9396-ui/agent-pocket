import React, { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { createPortal } from "react-dom";

export function IconButton({ label, children, onClick, disabled, className = "" }: {
  label: string; children: React.ReactNode; onClick?: () => void; disabled?: boolean; className?: string;
}) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>;
}

export function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null); const titleId = useId();
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    const shell = document.querySelector<HTMLElement>(".workspace-shell");
    if (shell) shell.inert = true;
    ref.current?.querySelector<HTMLElement>("button,input")?.focus();
    return () => { if (shell) shell.inert = false; if (prior?.isConnected) prior.focus(); };
  }, []);
  return createPortal(<div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="modal" ref={ref} onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (event.key !== "Tab") return;
      const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]') || []).filter((node) => node.getClientRects().length);
      if (!nodes.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
      <div className="modal-heading"><h2 id={titleId}>{title}</h2><IconButton label="关闭" onClick={onClose}><X size={18} /></IconButton></div>
      {children}
    </div>
  </div>, document.body);
}
