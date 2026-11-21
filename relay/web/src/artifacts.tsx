import React, { useEffect, useRef, useState } from "react";
import { Download, File as FileIcon, Image as ImageIcon, Share2 } from "lucide-react";
import { Modal } from "./ui";

export type Artifact = { id: string; messageId: string; source: string; name: string; mimeType: string; size: number; unavailable?: string };
export type ArtifactCall = (method: string, params: any) => Promise<any>;
export async function readArtifact(call: ArtifactCall, artifact: Artifact, signal: AbortSignal, progress: (value: number) => void) {
  if (!Number.isSafeInteger(artifact.size) || artifact.size < 0 || artifact.size > 32 * 1024 * 1024) throw new Error("文件大小超出支持范围");
  const parts: Uint8Array<ArrayBuffer>[] = []; let offset = 0;
  do {
    if (signal.aborted) throw new DOMException("已取消", "AbortError");
    const chunk = await call("artifact/read", { id: artifact.id, offset });
    if (signal.aborted) throw new DOMException("已取消", "AbortError");
    if (typeof chunk.data !== "string" || chunk.data.length > 262144 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)) throw new Error("文件数据无效");
    const bytes = Uint8Array.from(atob(chunk.data), char => char.charCodeAt(0));
    if (chunk.id !== artifact.id || chunk.offset !== offset || chunk.size !== artifact.size || chunk.nextOffset !== offset + bytes.length || chunk.nextOffset > artifact.size || chunk.done !== (chunk.nextOffset === artifact.size) || (!bytes.length && !chunk.done)) throw new Error("文件已变化，请重新载入");
    parts.push(bytes); offset = chunk.nextOffset; progress(artifact.size ? Math.round(offset / artifact.size * 100) : 100);
  } while (offset < artifact.size);
  return new Blob(parts, { type: artifact.mimeType });
}

export function ArtifactCard({ artifact, call, connected }: { artifact: Artifact; call?: ArtifactCall; connected: boolean }) {
  const [blob, setBlob] = useState<Blob>(); const [url, setUrl] = useState(""); const [text, setText] = useState("");
  const [busy, setBusy] = useState(false); const [progress, setProgress] = useState(0); const [error, setError] = useState(""); const [preview, setPreview] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const raster = /^image\/(png|jpeg|webp|gif)$/.test(artifact.mimeType); const readable = artifact.mimeType === "text/plain" && artifact.size <= 512 * 1024;
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { if (!blob) return; const next = URL.createObjectURL(blob); setUrl(next); return () => URL.revokeObjectURL(next); }, [blob]);
  const load = async () => {
    if (busy || !call || !connected || artifact.unavailable) return;
    const controller = new AbortController(); abort.current = controller; setBusy(true); setError("");
    try { const result = await readArtifact(call, artifact, controller.signal, setProgress); const content = readable ? await result.text() : ""; if (controller.signal.aborted) return; setBlob(result); setText(content); }
    catch (caught: any) { if (!controller.signal.aborted) setError(caught.message || "读取失败，请刷新任务后重试"); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  useEffect(() => {
    if (!raster || !connected || !call || blob || artifact.unavailable || artifact.size > 4 * 1024 * 1024 || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); void load(); } });
    if (card.current) observer.observe(card.current);
    return () => observer.disconnect();
  }, [artifact.id, connected]);
  const save = async () => {
    if (!blob || !url) return;
    const file = new File([blob], artifact.name, { type: blob.type });
    // Web Share opens iOS' native save/share sheet without navigating WKWebView
    // away from its configured origin. It requires this second user gesture.
    const mobile = /iPhone|iPad|iPod|Android|AgentPocket-iOS/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    if (mobile && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: artifact.name }); }
      catch (caught: any) { if (caught.name !== "AbortError") setError("分享未完成，请重试，或在浏览器中保存文件"); }
    } else if (/AgentPocket-iOS/.test(navigator.userAgent)) {
      setError("当前 iOS 外壳不支持保存此文件。图片可在预览中长按保存，其他文件请用 Safari 打开网页版下载。");
    } else { const link = document.createElement("a"); link.href = url; link.download = artifact.name; document.body.append(link); link.click(); link.remove(); }
  };
  return <div className="artifact-card" ref={card}>
    <div className="artifact-heading">{raster ? <ImageIcon size={21} /> : <FileIcon size={21} />}<span>{artifact.name}<small>{artifact.size ? `${Math.ceil(artifact.size / 1024)} KiB` : "文件"} · 电脑文件</small></span></div>
    {artifact.unavailable ? <p className="artifact-error">{artifact.unavailable}</p> : <div className="artifact-actions">
      {!blob && <button type="button" onClick={() => void load()} disabled={!connected || busy || !call}>{busy ? `读取中 ${progress}%` : raster ? "显示图片" : "读取文件"}</button>}
      {blob && <><button type="button" onClick={() => void save()}><Share2 size={14} /> 保存 / 分享</button>{(raster || readable) && <button type="button" onClick={() => setPreview(true)}>放大查看</button>}</>}
    </div>}
    {url && raster && <img className="artifact-image" src={url} alt={artifact.name} loading="lazy" onClick={() => setPreview(true)} />}
    {blob && readable && <pre className="artifact-text">{text}</pre>}
    {error && <p className="artifact-error" role="status">{error}</p>}
    {preview && <Modal title={artifact.name} onClose={() => setPreview(false)}>{raster ? <img className="artifact-preview" src={url} alt={artifact.name} /> : <pre className="artifact-text">{text}</pre>}<button className="attach-file-button" onClick={() => void save()}><Download size={16} />保存 / 分享</button></Modal>}
  </div>;
}
