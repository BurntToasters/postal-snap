import { strings } from "./i18n";
import type { OutboxSummary } from "./types";

export function outboxDetail(
  item: Pick<OutboxSummary, "reasonCode" | "detail">,
): string | undefined {
  const reasons = strings.mail.outboxReasons;
  const code = item.reasonCode;
  if (code && Object.hasOwn(reasons, code)) {
    return reasons[code as keyof typeof reasons];
  }
  return item.detail ?? undefined;
}
