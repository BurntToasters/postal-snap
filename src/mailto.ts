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

/** Decode once. RFC 6068: "+" is literal, unlike form encoding. */
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseMailtoInner(value: string): MailtoDraft {
  if (!/^mailto:/i.test(value.trim())) return { ...EMPTY };
  const rest = value.trim().slice("mailto:".length).split("#")[0];
  const queryAt = rest.indexOf("?");
  const path = queryAt < 0 ? rest : rest.slice(0, queryAt);
  // hfnames are case-insensitive; the first value of each wins.
  const fields = new Map<string, string>();
  for (const pair of queryAt < 0 ? [] : rest.slice(queryAt + 1).split("&")) {
    const equals = pair.indexOf("=");
    const name = decode(equals < 0 ? pair : pair.slice(0, equals))
      .trim()
      .toLowerCase();
    if (!name || fields.has(name)) continue;
    fields.set(name, equals < 0 ? "" : pair.slice(equals + 1));
  }
  const split = (encoded: string) =>
    encoded
      .split(/[;,]|%2C|%3B/i)
      .map((item) => decode(item).trim())
      .filter((item) => item.length > 0 && item.length <= 320)
      .slice(0, 100);
  const field = (name: string, limit: number) =>
    decode(fields.get(name) ?? "").slice(0, limit);
  return {
    to: [...split(path), ...split(fields.get("to") ?? "")].slice(0, 100),
    cc: split(fields.get("cc") ?? ""),
    bcc: split(fields.get("bcc") ?? ""),
    subject: field("subject", 998),
    textBody: field("body", 100_000),
  };
}
