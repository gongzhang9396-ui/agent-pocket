export type ApiError = { error?: { code?: string; message?: string } };

function csrfCookie() {
  const item = document.cookie.split(";").map((value) => value.trim()).find((value) => value.startsWith("ap_csrf="));
  return item ? decodeURIComponent(item.slice("ap_csrf=".length)) : "";
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if ((init.method || "GET").toUpperCase() !== "GET") headers.set("x-csrf-token", csrfCookie());
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const body = await response.json().catch(() => ({})) as T & ApiError;
  if (!response.ok) throw new Error(body.error?.message || `请求失败 (${response.status})`);
  return body;
}

export function post<T>(path: string, body: unknown) {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}
