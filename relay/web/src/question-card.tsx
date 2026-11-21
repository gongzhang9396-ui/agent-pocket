import React, { useState } from "react";
import { Check, HelpCircle } from "lucide-react";

export type QuestionItem = { type: string; id: string; requestId: string; questionId?: string; prompt?: string;
  options?: Array<string | { label: string; description?: string }>; selectedOption?: string | null;
  available?: boolean; unavailableReason?: string; submissionState?: string; multiSelect?: boolean };
export type QuestionAnswers = Record<string, { answers: string[] }>;
export function groupQuestions(items: any[]): QuestionItem[][] {
  const groups = new Map<string, QuestionItem[]>();
  for (const item of items) if (item.type === "pocketQuestion" && typeof item.requestId === "string") {
    const group = groups.get(item.requestId) || []; group.push(item); groups.set(item.requestId, group);
  }
  return [...groups.values()];
}
export function questionActionable(item: QuestionItem, fresh: boolean, capable: boolean): boolean {
  return fresh && capable && item.type === "pocketQuestion" && item.available === true
    && item.selectedOption == null && !item.unavailableReason && !item.submissionState;
}
export function questionOptions(item: QuestionItem): Array<{ label: string; description?: string }> {
  return (item.options || []).flatMap((option) => typeof option === "string" ? [{ label: option }]
    : option && typeof option.label === "string" ? [{ label: option.label, description: typeof option.description === "string" ? option.description : undefined }] : []);
}
export function QuestionCard({ items, fresh, capable, busy, onAnswer }: {
  items: QuestionItem[]; fresh: boolean; capable: boolean; busy: boolean;
  onAnswer: (requestId: string, answers: QuestionAnswers) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const response = (item: QuestionItem) => [...new Set([...(answers[item.questionId || 'question'] || []),
    ...(custom[item.questionId || 'question']?.trim() ? [custom[item.questionId || 'question'].trim()] : [])])];
  const answered = items.every((item) => item.selectedOption != null);
  const actionable = items.every((item) => questionActionable(item, fresh, capable));
  const complete = items.every((item) => response(item).length > 0 && response(item).length <= 10);
  const uncertain = items.some((item) => item.submissionState);
  if (answered) return <section className="answered-card" aria-label="已回答的问题"><Check size={16} /><div><strong>已回答</strong>{items.map((item) => <span key={item.id}>{item.selectedOption}</span>)}</div></section>;
  return <section className="question-card" aria-label="需要确认的问题">
    <div className="question-title"><HelpCircle size={17} /><strong>需要你确认</strong><span>{items.length} 个问题</span></div>
    {items.map((item) => {
      const id = item.questionId || "question";
      return <div className="question-item" key={item.id}><p>{item.prompt || "请选择或输入回答"}</p>
        {item.selectedOption != null ? <div className="selected-answer">已回答：{item.selectedOption}</div> : <>
          <div className="question-options">{questionOptions(item).map((option, index) => <button type="button" key={`${index}:${option.label}`} className={answers[id]?.includes(option.label) ? "chosen" : ""}
            disabled={busy || !actionable} aria-pressed={answers[id]?.includes(option.label) || false} onClick={() => {
              setAnswers(current => { const values = current[id] || []; return { ...current, [id]: item.multiSelect ? values.includes(option.label) ? values.filter(value => value !== option.label) : [...values, option.label].slice(0, 10) : [option.label] }; });
              if (!item.multiSelect) setCustom(current => ({ ...current, [id]: '' }));
            }}>
            <span className="option-number">{index + 1}</span><span>{option.label}{option.description && <small>{option.description}</small>}</span>{answers[id]?.includes(option.label) && <Check size={16} />}
          </button>)}</div>
          {actionable && <label className="question-custom">也可以直接输入<textarea rows={2} value={custom[id] || ""} disabled={busy} onChange={(event) => {
            const value = event.target.value; setCustom(current => ({ ...current, [id]: value })); if (!item.multiSelect && value.trim()) setAnswers(current => ({ ...current, [id]: [] }));
          }} /></label>}
        </>}
      </div>;
    })}
    {actionable ? <button className="primary-button" disabled={busy || !complete} onClick={() => onAnswer(items[0].requestId, Object.fromEntries(items.map((item) => [item.questionId || "question", { answers: response(item) }])))}>提交回答</button>
      : <p className="muted" role="status">{uncertain ? "回答已提交，等待确认；不会重复发送。" : !fresh ? "连接与问题状态同步后可继续" : items.find((item) => item.unavailableReason)?.unavailableReason || "请在电脑上处理这个问题"}</p>}
  </section>;
}
