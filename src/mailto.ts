export interface MailtoDraft {
  to: string[];
  cc: string[];
  subject: string;
  textBody: string;
}

export function parseMailto(value: string): MailtoDraft {
  const url = new URL(value);
  if (url.protocol.toLowerCase() !== "mailto:")
    throw new Error("Only mail links can open the composer.");
  const split = (input: string) =>
    input
      .split(/[;,]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 100);
  return {
    to: split(decodeURIComponent(url.pathname)),
    cc: split(url.searchParams.get("cc") ?? ""),
    subject: (url.searchParams.get("subject") ?? "").slice(0, 998),
    textBody: (url.searchParams.get("body") ?? "").slice(0, 100_000),
  };
}
