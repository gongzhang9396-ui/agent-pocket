import React, {useState} from 'react';
import ReactMarkdown, {defaultUrlTransform} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {Check,Copy} from 'lucide-react';

function CodeBlock({children}: {children?:React.ReactNode}) {
  const [copied,setCopied]=useState(false);
  return <div className="code-block"><div className="code-toolbar"><span>代码</span><button type="button" title="复制代码" aria-label="复制代码" onClick={async event=>{const text=event.currentTarget.closest('.code-block')?.querySelector('code')?.textContent||'';try{await navigator.clipboard.writeText(text);setCopied(true);setTimeout(()=>setCopied(false),1600)}catch{setCopied(false)}}}>{copied?<Check size={13}/>:<Copy size={13}/>}<span>{copied?'已复制':'复制'}</span></button></div><pre>{children}</pre></div>;
}
export function Markdown({text}:{text:string}) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url=>/^(https?:|mailto:)/i.test(url)?defaultUrlTransform(url):''} components={{
    a:({node:_,...props})=>props.href ? <a {...props} target="_blank" rel="noopener noreferrer"/> : <span className="artifact-inline">{props.children}</span>,
    img:({alt})=><span className="image-placeholder">图片：{alt||'附件图片'}</span>,
    pre:({children})=><CodeBlock>{children}</CodeBlock>,
    table:({children})=><div className="table-scroll"><table>{children}</table></div>,
  }}>{text}</ReactMarkdown></div>;
}
