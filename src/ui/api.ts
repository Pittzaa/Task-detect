export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly data?: Record<string, unknown>, readonly issues?: { path: string; message: string }[]) {
    super(message);
  }
}

/** Same-origin JSON fetch. Cookies carry the session; the server checks Origin on mutations. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let data: unknown = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; data?: Record<string, unknown>; issues?: { path: string; message: string }[] } } | null)?.error;
    throw new ApiError(e?.code ?? "INTERNAL", e?.message ?? res.statusText, res.status, e?.data, e?.issues);
  }
  return data as T;
}

/** Better Auth endpoints live under /api/auth and use a slightly different error shape. */
export async function authApi<T = unknown>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const res = await fetch(`/api/auth${path}`, { method, credentials: "same-origin", headers: body !== undefined ? { "content-type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data: unknown = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const e = data as { message?: string; code?: string } | null;
    throw new ApiError(e?.code ?? "AUTH_ERROR", e?.message ?? res.statusText, res.status);
  }
  return data as T;
}
