export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function request<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    csrf?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    signal: options.signal,
    headers: {
      ...(options.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...(options.csrf ? { "X-CSRF-Token": options.csrf } : {}),
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  const payload = await response
    .json()
    .catch(() => ({ error: "服务器返回了无法读取的响应。" }));
  if (!response.ok)
    throw new ApiError(
      payload.error || `请求失败 (${response.status})`,
      response.status,
    );
  return payload as T;
}
export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败，请稍后重试。";
