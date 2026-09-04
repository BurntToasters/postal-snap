import { describe, expect, it } from "vitest";
import {
  htmlToPlainText,
  messageFrameDocument,
  sanitizeReceivedHtml,
} from "../security";

describe("received mail isolation", () => {
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
      <img src="//tracker.test/protocol-relative.gif">
      <svg><a href="https://tracker.test/svg">vector</a></svg>
    `);
    expect(result.blockedImages).toBe(2);
    expect(result.html).not.toMatch(
      /script|form|onclick|onerror|javascript:|background|srcset|file:|svg|video|poster/i,
    );
    expect(result.html).toContain("data-remote-src");
    expect(result.html).toContain("https://tracker.test/protocol-relative.gif");
  });

  it("creates a scriptless, networkless iframe document", () => {
    const document = messageFrameDocument("<p>Hello</p>", 1.5);
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("form-action 'none'");
    expect(document).not.toContain("allow-scripts");
    expect(document).toContain("font:24px");
    expect(document).toContain('name="viewport"');
  });

  it("turns CID images into inert opaque references", () => {
    const result = sanitizeReceivedHtml(
      '<p>Hello</p><img src="cid:<photo-1@example.test>">',
    );
    expect(result.html).not.toContain('src="cid:');
    expect(result.html).toContain('data-inline-cid="photo-1@example.test"');
  });

  it("generates a readable text alternative", () => {
    expect(htmlToPlainText("<h1>Hello</h1><p>Postal Snap</p>")).toBe(
      "Hello\nPostal Snap",
    );
  });
});
