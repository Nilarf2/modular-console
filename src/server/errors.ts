export class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
export function requireValue<T>(value: T | undefined, message: string): T {
  if (!value) throw new HttpError(404, message);
  return value;
}
