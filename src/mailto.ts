export interface MailtoDraft {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  textBody: string;
}

const EMPTY: MailtoDraft = {
  to: [],
  cc: [],
  bcc: [],
  subject: "",
  textBody: "",
};

export function parseMailto(value: string): MailtoDraft {
  try {
    return parseMailtoInner(value);
  } catch {
    return { ...EMPTY };
  }
}

function parseMailtoInner(value: string): MailtoDraft {
  const url = new URL(value);
  if (url.protocol.toLowerCase() !== "mailto:") return { ...EMPTY };
  const split = (input: string) =>
    input
      .split(/[;,]/)
      .map((item) => {
        try {
          return decodeURIComponent(item).trim();
        } catch {
          return item.trim();
        }
      })
      .filter((item) => item.length > 0 && item.length <= 320)
      .slice(0, 100);
  const field = (name: string, limit: number) =>
    (url.searchParams.get(name) ?? "").slice(0, limit);
  return {
    to: [
      ...split(safeDecodePath(url)),
      ...split(url.searchParams.get("to") ?? ""),
    ].slice(0, 100),
    cc: split(url.searchParams.get("cc") ?? ""),
    bcc: split(url.searchParams.get("bcc") ?? ""),
    subject: field("subject", 998),
    textBody: field("body", 100_000),
  };
}

function safeDecodePath(url: URL): string {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return url.pathname;
  }
}
