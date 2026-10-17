export type ErrorCode = "NOT_FOUND" | "FORBIDDEN" | "UNAUTHENTICATED" | "VALIDATION" | "CONFLICT" | "RATE_LIMITED" | "UNAVAILABLE";

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    /** Internal context for logs/audit only. Never serialized to clients. */
    readonly detail?: Record<string, string>,
    /** Safe, non-sensitive structured data that IS returned to the client (e.g. a count of blockers). */
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const unauthenticated = () => new AppError("UNAUTHENTICATED", "Authentication required", 401);
export const forbidden = (detail?: Record<string, string>) => new AppError("FORBIDDEN", "Not allowed", 403, detail);
/** Also used for resources in other tenants, so existence is never disclosed. */
export const notFound = () => new AppError("NOT_FOUND", "Not found", 404);
export const validation = (message: string, data?: Record<string, unknown>) => new AppError("VALIDATION", message, 422, undefined, data);
export const conflict = (message: string) => new AppError("CONFLICT", message, 409);
export const rateLimited = () => new AppError("RATE_LIMITED", "Too many requests", 429);
/** The service refuses to operate because a safety precondition is not met (for example a misconfigured database role). */
export const unavailable = () => new AppError("UNAVAILABLE", "Service unavailable", 503);
