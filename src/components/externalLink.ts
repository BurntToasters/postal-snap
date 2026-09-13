import { api } from "../api";
import { strings } from "../i18n";

export const APPLE_APP_PASSWORD_GUIDE_URL = "https://support.apple.com/102654";

export type ExternalLinkOutcome = "opened" | "declined" | "failed";

export async function inspectAndOpenExternalLink(
  url: string,
): Promise<ExternalLinkOutcome> {
  try {
    const check = await api.inspectExternalUrl(url);
    const shownUrl =
      check.url.length > 1400 ? `${check.url.slice(0, 1400)}…` : check.url;
    if (check.reportedThreat) {
      const proceed = await api.showNativeConfirm(
        strings.reader.reportedThreatTitle,
        strings.reader.reportedThreat(check.hostname, shownUrl),
      );
      if (!proceed) return "declined";
      const anyway = await api.showNativeConfirm(
        strings.reader.reportedThreatTitle,
        strings.reader.reportedThreatOpenAnyway,
      );
      if (!anyway) return "declined";
    } else {
      const confirmed = await api.showNativeConfirm(
        strings.appName,
        strings.reader.openLink(check.hostname, shownUrl),
      );
      if (!confirmed) return "declined";
    }
    await api.openExternalUrl(check.url, check.reportedThreat);
    return "opened";
  } catch {
    return "failed";
  }
}
