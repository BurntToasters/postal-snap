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
  "certificateFailed",
  "certificateInvalid",
  "pendingOperations",
  "folderAttention",
  "identityConfirmation",
  "localStorageFailed",
  "invalidInput",
  "operationFailed",
]);

export class PostalError extends Error {
  readonly code: IpcErrorCode;
  readonly retryable: boolean;
  readonly stage?: "imap" | "smtp";

  constructor(payload: IpcErrorPayload) {
    super(strings.errors[payload.code]);
    this.name = "PostalError";
    this.code = payload.code;
    this.retryable = payload.retryable;
    this.stage = payload.stage;
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
  const endpoint = error.stage;
  if (error.code === "authenticationFailed") {
    return {
      text:
        endpoint === "imap"
          ? strings.setup.imapSignInFailed
          : endpoint === "smtp"
            ? strings.setup.smtpSignInFailed
            : error.message,
      hint:
        provider === "icloud"
          ? strings.setup.authHintIcloud
          : provider === "protonBridge"
            ? strings.setup.bridgePasswordHint
            : strings.setup.authHintManual,
      showAppPasswordLink: provider === "icloud",
    };
  }
  if (error.code === "pendingOperations" || error.code === "certificateInvalid")
    return { text: error.message };
  if (error.code === "certificateFailed" && endpoint) {
    return {
      text:
        endpoint === "imap"
          ? strings.setup.imapCertificateFailed
          : strings.setup.smtpCertificateFailed,
      hint:
        provider === "protonBridge"
          ? strings.setup.bridgeCertificateHint
          : undefined,
    };
  }
  if (provider === "protonBridge" && error.code === "certificateFailed") {
    return {
      text: strings.errors.certificateFailed,
      hint: strings.setup.bridgeCertificateHint,
    };
  }
  if (error.code === "connectionFailed" && endpoint) {
    return {
      text:
        endpoint === "imap"
          ? strings.setup.imapConnectionFailed
          : strings.setup.smtpConnectionFailed,
      hint: connectionHint(provider, endpoint),
    };
  }
  if (provider === "protonBridge" && error.code === "connectionFailed") {
    return {
      text: strings.errors.connectionFailed,
      hint: strings.setup.bridgeUnavailableHint,
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

function connectionHint(
  provider: ProviderKind,
  endpoint: "imap" | "smtp",
): string {
  if (provider === "protonBridge")
    return endpoint === "imap"
      ? strings.setup.bridgeImapConnectionHint
      : strings.setup.bridgeSmtpConnectionHint;
  if (provider === "icloud")
    return endpoint === "imap"
      ? strings.setup.icloudImapConnectionHint
      : strings.setup.icloudSmtpConnectionHint;
  return endpoint === "imap"
    ? strings.setup.imapConnectionHint
    : strings.setup.smtpConnectionHint;
}

function isPayload(value: unknown): value is IpcErrorPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<IpcErrorPayload>;
  return (
    typeof payload.code === "string" &&
    codes.has(payload.code as IpcErrorCode) &&
    typeof payload.message === "string" &&
    typeof payload.retryable === "boolean" &&
    (payload.stage === undefined ||
      payload.stage === "imap" ||
      payload.stage === "smtp")
  );
}
