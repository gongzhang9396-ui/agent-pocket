import React from "react";
import { File as FileIcon, X } from "lucide-react";
import { attachmentPayload, validateAttachmentBudget } from "./crypto";
import { IconButton } from "./ui";

export type Attachment = Awaited<ReturnType<typeof attachmentPayload>>;
export const attachmentAccept = "image/png,image/jpeg,image/webp,.txt,.md,.json,.csv,.pdf,.log,.yaml,.yml,.xml,.js,.ts,.py";
export async function prepareAttachments(files: File[], existing: Attachment[]) {
  // Check metadata before allocating/encoding user-selected files.
  const metadata = files.map(file => ({ mimeType: file.type || "application/octet-stream", rawBytes: file.size }));
  validateAttachmentBudget([...existing, ...metadata]);
  if (files.some(file => !file.size)) throw new Error("不能添加空文件");
  const result = [...existing, ...await Promise.all(files.map(attachmentPayload))];
  validateAttachmentBudget(result);
  return result;
}
export function AttachmentList({ items, disabled, onRemove }: { items: Attachment[]; disabled?: boolean; onRemove: (index: number) => void }) {
  if (!items.length) return null;
  return <div className="attachment-chips">{items.map((item, i) => <div className="attachment-chip" key={`${item.filename}:${i}`}>
    {/^image\/(png|jpeg|webp)$/.test(item.mimeType) ? <img className="attachment-thumb" src={`data:${item.mimeType};base64,${item.data}`} alt={item.filename} /> : <FileIcon size={18} />}
    <span>{item.filename}<small>{Math.ceil(item.rawBytes / 1024)} KiB</small></span>
    <IconButton label={`移除 ${item.filename}`} disabled={disabled} onClick={() => onRemove(i)}><X size={14} /></IconButton>
  </div>)}</div>;
}
export function attachmentParams(items: Attachment[]) {
  validateAttachmentBudget(items);
  return { images: items.filter(item => item.mimeType.startsWith("image/")).map(({ mimeType, data }) => ({ mimeType, data })),
    files: items.filter(item => !item.mimeType.startsWith("image/")).map(({ filename, mimeType, data }) => ({ filename, mimeType, data })) };
}
