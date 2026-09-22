import { createHash } from "node:crypto";

export const ASYNC_QUESTION_METHOD = "desktop/asyncQuestion";
export const ASYNC_QUESTION_PREFIX = "async:";
const REPLY_OPEN = "<send_user_message_question_reply>";
const REPLY_CLOSE = "</send_user_message_question_reply>";

/** Desktop's asynchronous questions are agent messages, not blocking RPC requests. */
export function desktopQuestions(threadId: string, item: any) {
  if (item?.type !== "agentMessage" || item.delivery !== "async" || typeof item.id !== "string") return [];
  const questions = Array.isArray(item.questions) && item.questions.length
    ? item.questions.slice(0, 3).map((q: any, index: number) => ({
      questionId: JSON.stringify(["request_user_input_async", item.id, index]),
      question: q?.title, options: q?.options,
    }))
    : [{ questionId: item.id, question: item.text, options: [] }];
  return questions.flatMap((q: any) => {
    if (typeof q.question !== "string" || !q.question.trim() || q.question.length > 12000 || q.questionId.length > 200) return [];
    const requestId = ASYNC_QUESTION_PREFIX + createHash("sha256").update(JSON.stringify([threadId, q.questionId])).digest("hex");
    return [{ requestId, threadId, questionId: q.questionId, question: q.question,
      options: Array.isArray(q.options) ? q.options.filter((v: any) => typeof v === "string" && v.length <= 4000).slice(0, 20) : [] }];
  });
}

export function desktopQuestionReplies(item: any): { questionItemId: string; question: string; answer: string }[] {
  if (item?.type !== "userMessage" && !(item?.type === "steeringUserMessage" && item.status === "accepted")) return [];
  const text = (Array.isArray(item.content) ? item.content : []).filter((c: any) => c?.type === "text")
    .map((c: any) => c.text || "").join("\n").trim();
  if (!text.startsWith(REPLY_OPEN) || !text.endsWith(REPLY_CLOSE) || text.length > 64000) return [];
  try {
    const parsed = JSON.parse(text.slice(REPLY_OPEN.length, -REPLY_CLOSE.length));
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((r: any) =>
      typeof r?.questionItemId === "string" && r.questionItemId.length <= 200 &&
      typeof r.question === "string" && typeof r.answer === "string" && r.answer.length <= 4000);
  } catch { return []; }
}

export function desktopQuestionReplyText(question: { questionId: string; question: string }, answer: string) {
  return `${REPLY_OPEN}\n${JSON.stringify([{ questionItemId: question.questionId, question: question.question, answer }])}\n${REPLY_CLOSE}`;
}
