import { strings } from "./i18n";
import type { IpcErrorCode, IpcErrorPayload } from "./types";

const codes = new Set<IpcErrorCode>([
  "accessDenied",
  "notFound",
  "limitExceeded",
  "authenticationFailed",
  "connectionFailed",
  "localStorageFailed",
  "invalidInput",
  "operationFailed",
]);

export class PostalError extends Error {
  readonly code: IpcErrorCode;
  readonly retryable: boolean;

  constructor(payload: IpcErrorPayload) {
    super(strings.errors[payload.code]);
    this.name = "PostalError";
    this.code = payload.code;
    this.retryable = payload.retryable;
  }

  override toString(): string {
    return this.message;
  }
}

export function normalizeIpcError(cause: unknown): PostalError {
  if (isPayload(cause)) return new PostalError(cause);
  const message = typeof cause === "string" ? cause : "";
  return new PostalError({
    code: "operationFailed",
    message: message || strings.errors.operationFailed,
    retryable: true,
  });
}

function isPayload(value: unknown): value is IpcErrorPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<IpcErrorPayload>;
  return (
    typeof payload.code === "string" &&
    codes.has(payload.code as IpcErrorCode) &&
    typeof payload.message === "string" &&
    typeof payload.retryable === "boolean"
  );
}
