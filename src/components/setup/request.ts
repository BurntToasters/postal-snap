import type { ProviderKind, ServerConfig, TlsMode } from "../../types";

export function emptyManualImap(username = ""): ServerConfig {
  return { host: "", port: 993, tlsMode: "tls", username };
}

export function emptyManualSmtp(username = ""): ServerConfig {
  return { host: "", port: 587, tlsMode: "startTls", username };
}

export function defaultPort(kind: "imap" | "smtp", tlsMode: TlsMode): number {
  if (kind === "imap") return tlsMode === "tls" ? 993 : 143;
  return tlsMode === "tls" ? 465 : 587;
}

export function isStandardPort(kind: "imap" | "smtp", port: number): boolean {
  return kind === "imap"
    ? port === 993 || port === 143
    : port === 465 || port === 587;
}

export function preparePassword(
  provider: ProviderKind,
  password: string,
): string {
  const trimmed = password.trim();
  return provider === "icloud" ? trimmed.replace(/\s+/g, "") : trimmed;
}

export function trimServer(server: ServerConfig): ServerConfig {
  return {
    ...server,
    host: server.host.trim(),
    username: server.username.trim(),
    port: Number.isFinite(server.port)
      ? Math.max(1, Math.min(65535, Math.trunc(server.port)))
      : server.port,
  };
}
