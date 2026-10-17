export type ErrorCode = "NOT_FOUND" | "FORBIDDEN" | "UNAUTHENTICATED" | "VALIDATION" | "CONFLICT";

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    /** Internal context for logs/audit only. Never serialized to clients. */
    readonly detail?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const unauthenticated = () => new AppError("UNAUTHENTICATED", "Authentication required", 401);
export const forbidden = (detail?: Record<string, string>) => new AppError("FORBIDDEN", "Not allowed", 403, detail);
/** Also used for resources in other tenants, so existence is never disclosed. */
export const notFound = () => new AppError("NOT_FOUND", "Not found", 404);
export const validation = (message: string) => new AppError("VALIDATION", message, 422);
export const conflict = (message: string) => new AppError("CONFLICT", message, 409);
