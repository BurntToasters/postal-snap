import { strings } from "./i18n";
import type { IpcErrorCode, IpcErrorPayload, ProviderKind } from "./types";

const codes = new Set<IpcErrorCode>([
  "accessDenied",
  "notFound",
  "limitExceeded",
  "settingsNotFound",
  "settingsTooLarge",
  "settingsInvalid",
  "settingsMigrationFailed",
  "settingsReadFailed",
  "settingsWriteFailed",
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

export function describeSetupError(
  cause: unknown,
  provider: ProviderKind,
): { text: string; hint?: string; showAppPasswordLink?: boolean } {
  const error = cause instanceof PostalError ? cause : normalizeIpcError(cause);
  if (error.code === "authenticationFailed") {
    return {
      text: error.message,
      hint:
        provider === "icloud"
          ? strings.setup.authHintIcloud
          : strings.setup.authHintManual,
      showAppPasswordLink: provider === "icloud",
    };
  }
  if (error.code === "connectionFailed") {
    return {
      text: error.message,
      hint: strings.setup.connectionHint,
    };
  }
  return { text: error.message };
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
