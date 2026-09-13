import { render } from "@testing-library/react";
import { createElement, createRef } from "react";
import { describe, expect, it } from "vitest";
import { MessageBody } from "../components/reader/messageBody";
import { strings } from "../i18n";
import {
  htmlToPlainText,
  messageFrameDocument,
  sanitizeComposeHtml,
  sanitizeReceivedHtml,
} from "../security";
import { makeMessage, messageDetail } from "./helpers/fixtures";

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

  it("strips usemap from images and map/area hotspots", () => {
    const result = sanitizeReceivedHtml(
      '<img src="https://images.example.test/pic.png" usemap="#nav"><map name="nav"><area shape="rect" coords="0,0,10,10" href="https://tracker.test/click"></map>',
    );
    expect(result.html).not.toMatch(/usemap|<map\b|<area\b/i);
    expect(result.html).not.toContain("tracker.test");
    expect(result.html).toContain("data-remote-src");
    expect(result.blockedImages).toBe(1);
  });

  it("creates a scriptless, networkless iframe document", () => {
    const document = messageFrameDocument("<p>Hello</p>", 1.5);
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("form-action 'none'");
    expect(document).not.toContain("allow-scripts");
    expect(document).not.toContain("blob:");
    expect(document).toContain("img-src data: cid:");
    expect(document).toContain("font:24px");
    expect(document).toContain('name="viewport"');
    expect(document).toContain("background:#ffffff");
    expect(document).not.toContain("background:transparent");
  });

  it("drops blob image sources because no blob producer exists", () => {
    const result = sanitizeReceivedHtml(
      '<img alt="local" src="blob:https://app.test/9f8e">',
    );
    expect(result.html).not.toContain("blob:");
    expect(result.html).toContain("<img");
  });

  it("stays idempotent after stripping hotspots and blob sources", () => {
    const once = sanitizeReceivedHtml(
      '<img src="blob:https://app.test/1" usemap="#nav"><map name="nav"><area href="https://tracker.test/click"></map>',
    );
    const twice = sanitizeReceivedHtml(once.html);
    expect(twice.html).toBe(once.html);
  });

  it("keeps the reader iframe sandboxed to same-origin only", () => {
    const { container } = render(
      createElement(MessageBody, {
        message: messageDetail(makeMessage(), {
          htmlBody: "<p>Hello</p>",
          textBody: "",
        }),
        frameHtml: messageFrameDocument("<p>Hello</p>"),
        filteredImages: 0,
        threatImages: 0,
        remainingBlockedImages: 0,
        loadingImages: false,
        findOpen: false,
        findQuery: "",
        findInputRef: createRef<HTMLInputElement>(),
        bodyRef: createRef<HTMLDivElement>(),
        frameRef: createRef<HTMLIFrameElement>(),
        onFindQueryChange: () => undefined,
        onCloseFind: () => undefined,
        onSubmitFind: () => undefined,
        onLoadImages: () => undefined,
        onFrameLoad: () => undefined,
        onOpenLink: () => undefined,
        onOpenMailto: () => undefined,
      }),
    );
    expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe(
      "allow-same-origin",
    );
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
  });

  it("generates a readable text alternative", () => {
    expect(htmlToPlainText("<h1>Hello</h1><p>Postal Snap</p>")).toBe(
      "Hello\nPostal Snap",
    );
  });
});
