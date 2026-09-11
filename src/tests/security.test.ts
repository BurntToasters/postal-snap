import { describe, expect, it } from "vitest";
import { strings } from "../i18n";
import {
  htmlToPlainText,
  messageFrameDocument,
  restoreComposeHtmlLinks,
  sanitizeComposeHtml,
  sanitizeReceivedHtml,
} from "../security";

describe("received mail isolation", () => {
  it("does not let message HTML forge image-filter results", () => {
    const result = sanitizeReceivedHtml(
      '<img src="https://images.example.test/photo.jpg" data-content-blocked="true" data-threat-blocked="true">',
    );
    expect(result.html).not.toContain("data-content-blocked");
    expect(result.html).not.toContain("data-threat-blocked");
    expect(result.blockedImages).toBe(1);
  });

  it("never labels a reported address as confirmed or Safe", () => {
    const text = [
      strings.reader.reportedThreatTitle,
      strings.reader.reportedThreat("host.test", "https://host.test/login"),
      strings.reader.reportedThreatOpenAnyway,
      strings.reader.threatImage,
      strings.reader.threatImages(2),
      strings.reader.openLink(
        "library.example.test",
        "https://library.example.test/hours",
      ),
      strings.settings.blockThreats,
      strings.settings.blockThreatsHelp,
      strings.settings.threatOffWarning,
      strings.settings.threatDisableTitle,
      strings.settings.threatDisableLead,
      strings.settings.protectionOn,
      strings.settings.protectionOff,
      strings.settings.protectionAdsOffHelp,
    ].join("\n");
    expect(text).not.toMatch(/confirmed/i);
    expect(text).not.toMatch(/\bSafe\b/);
  });
  it("removes active content and unsafe schemes", () => {
    const result = sanitizeReceivedHtml(`
      <script>alert(1)</script><form action="https://bad.test"><input></form>
      <a href="javascript:alert(2)" onclick="steal()">bad</a>
      <img src="https://tracker.test/pixel.gif" onerror="steal()">
      <p style="background:url(https://tracker.test/css)">hello</p>
      <p style="background:u\\72l(https://tracker.test/escaped)">escaped</p>
      <img src="file:///etc/passwd" srcset="https://tracker.test/2x 2x">
      <video src="https://tracker.test/movie" poster="https://tracker.test/poster"></video>
      <table background="https://tracker.test/table"><tr><td>cell</td></tr></table>
      <p src="https://tracker.test/paragraph">keep text</p>
      <img src="//tracker.test/protocol-relative.gif" data-evil="1">
      <svg><a href="https://tracker.test/svg">vector</a></svg>
    `);
    expect(result.blockedImages).toBe(2);
    expect(result.html).not.toMatch(
      /script|form|onclick|onerror|javascript:|background|srcset|file:|svg|video|poster/i,
    );
    expect(result.html).toContain("data-remote-src");
    expect(result.html).toContain("https://tracker.test/protocol-relative.gif");
    expect(result.html).not.toContain("data-evil");
    expect(result.html).toContain("keep text");
    expect(result.html).not.toMatch(/src="https:\/\/tracker\.test\/paragraph"/);
  });

  it("creates a scriptless, networkless iframe document", () => {
    const document = messageFrameDocument("<p>Hello</p>", 1.5);
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("form-action 'none'");
    expect(document).not.toContain("allow-scripts");
    expect(document).toContain("font:24px");
    expect(document).toContain('name="viewport"');
    expect(document).toContain("background:#ffffff");
    expect(document).not.toContain("background:transparent");
  });

  it("turns CID images into inert opaque references", () => {
    const result = sanitizeReceivedHtml(
      '<p>Hello</p><img src="cid:<photo-1@example.test>">',
    );
    expect(result.html).not.toContain('src="cid:');
    expect(result.html).toContain('data-inline-cid="photo-1@example.test"');
  });

  it("keeps rust-sanitized remote and cid markers", () => {
    const result = sanitizeReceivedHtml(
      '<img data-remote-src="https://images.example.test/pic.png" class="remote-image-blocked" alt="Remote image blocked"><img data-inline-cid="photo-1@example.test" alt="Inline image">',
    );
    expect(result.html).toContain(
      'data-remote-src="https://images.example.test/pic.png"',
    );
    expect(result.html).toContain('data-inline-cid="photo-1@example.test"');
    expect(result.blockedImages).toBe(1);
  });

  it("sanitizes draft HTML for the composer but keeps cid images", () => {
    const html = sanitizeComposeHtml(
      '<p>Hello</p><img src="cid:<photo-1@example.test>"><img src=x onerror="steal()"><script>alert(1)</script>',
    );
    expect(html).toContain('src="cid:photo-1@example.test"');
    expect(html).not.toMatch(/script|onerror|alert/i);
  });

  it("keeps received http links off href so context menus cannot skip inspection", () => {
    const result = sanitizeReceivedHtml(
      '<p><a href="https://library.example.test/hours">Hours</a></p>',
    );
    expect(result.html).toContain(
      'data-external-href="https://library.example.test/hours"',
    );
    expect(result.html).not.toContain('<a href="https://');
    const compose = sanitizeComposeHtml(result.html);
    expect(compose).toContain(
      'data-external-href="https://library.example.test/hours"',
    );
    expect(compose).not.toContain('<a href="https://');
    const outgoing = restoreComposeHtmlLinks(compose);
    expect(outgoing).toContain('href="https://library.example.test/hours"');
    expect(outgoing).not.toContain("data-external-href");
  });

  it("generates a readable text alternative", () => {
    expect(htmlToPlainText("<h1>Hello</h1><p>Postal Snap</p>")).toBe(
      "Hello\nPostal Snap",
    );
  });
});
