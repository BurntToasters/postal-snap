import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  TWEETFEED_MANIFEST_URL,
  downloadSource,
  downloadTweetfeedManifest,
  officialSources,
  publishedTweetfeedChecksum,
  tweetfeedSources,
  updateFilters,
  updateTweetfeedFilters,
  validateSource,
  verifyFilters,
} from "./content-filters.js";

function fixture(source) {
  if (source.kind === "easylist") {
    return Buffer.from(
      `${source.header}\n! Version: 202609090000\n! Title: ${source.title}\n! Commit: ${"a".repeat(40)}\n${"||tracker.test^$image\n".repeat(1000)}`,
    );
  }
  if (source.kind === "license-cc-by-sa") {
    return Buffer.from(
      `Attribution-ShareAlike 3.0 Unported\n${"License fixture.\n".repeat(1000)}`,
    );
  }
  if (source.kind === "license-cc0") {
    return Buffer.from(
      `CC0 1.0 Universal\n${"License fixture.\n".repeat(200)}`,
    );
  }
  const entries =
    source.kind === "tweetfeed-urls"
      ? [
          "https://evil.test/phish",
          "https://phish.test/login",
          "https://malware.test/payload",
        ]
      : ["evil.test", "phish.test", "malware.test"];
  return Buffer.from(
    `# TweetFeed blocklist - test\n# Window: 30 days\n# Entries: ${entries.length}\n# Updated: 2026-09-09T00:00:00Z\n# License: CC0\n# Source: ${source.url}\n# https://tweetfeed.live\n# Community-reported IOCs. Use at your own risk.\n\n${entries.join("\n")}\n`,
  );
}

test("filter downloads allow only fixed official HTTPS endpoints and reject redirects", async () => {
  let called = false;
  await assert.rejects(
    downloadSource(
      { file: "easylist.txt", url: "https://mirror.example.test/list" },
      () => {
        called = true;
      },
    ),
    /official/,
  );
  assert.equal(called, false);
  await downloadSource(officialSources[0], async (url, options) => {
    assert.equal(url, "https://easylist.to/easylist/easylist.txt");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(fixture(officialSources[0]));
  });
  await assert.rejects(
    downloadSource(
      officialSources[0],
      async () => new Response("", { status: 302 }),
    ),
    /failed/,
  );
});

test("filter validation rejects HTML, wrong lists, missing provenance and oversized bodies", async () => {
  const source = officialSources[0];
  assert.throws(
    () => validateSource(source, Buffer.from("<html>Unavailable</html>")),
    /header/,
  );
  assert.throws(
    () => validateSource(source, fixture(officialSources[1])),
    /header/,
  );
  assert.throws(
    () =>
      validateSource(
        source,
        Buffer.from(`${source.header}\n! Title: ${source.title}\n`),
      ),
    /Incomplete/,
  );
  await assert.rejects(
    downloadSource(
      source,
      async () =>
        new Response("", { headers: { "content-length": "10485761" } }),
    ),
    /too large/,
  );
  await assert.rejects(
    downloadSource(source, async () => new Response(new Uint8Array(10485761))),
    /too large/,
  );
});

test("TweetFeed snapshots require official headers and reject URL-like domain lines", () => {
  const domains = officialSources.find(
    (source) => source.kind === "tweetfeed-domains",
  );
  const urls = officialSources.find(
    (source) => source.kind === "tweetfeed-urls",
  );
  assert.equal(
    domains.url,
    "https://api.tweetfeed.live/v1/blocklist/domains.txt",
  );
  assert.equal(urls.url, "https://api.tweetfeed.live/v1/blocklist/urls.txt");
  validateSource(domains, fixture(domains));
  validateSource(urls, fixture(urls));
  assert.throws(
    () => validateSource(domains, fixture(urls)),
    /header|Unexpected/,
  );
  assert.throws(
    () =>
      validateSource(
        domains,
        Buffer.from(
          `# TweetFeed blocklist - test\n# Window: 30 days\n# Entries: 1\n# Updated: 2026-09-09T00:00:00Z\n# License: CC0\n# Source: ${domains.url}\n# https://tweetfeed.live\n\nhttps://evil.test/phish\n`,
        ),
      ),
    /header/,
  );
});

function tweetfeedManifestFor(sources = officialSources) {
  return {
    schema_version: 1,
    generated_at: "2026-09-09T00:00:00Z",
    api_base: "https://api.tweetfeed.live",
    artifacts: sources
      .filter(
        (source) =>
          source.kind === "tweetfeed-domains" ||
          source.kind === "tweetfeed-urls",
      )
      .map((source) => {
        const bytes = fixture(source);
        return {
          name: source.file,
          api_url: source.url,
          bytes: bytes.length,
          rows: 3,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      }),
  };
}

function testFetcher() {
  return async (url) => {
    if (url === TWEETFEED_MANIFEST_URL) {
      return new Response(JSON.stringify(tweetfeedManifestFor()));
    }
    return new Response(
      fixture(officialSources.find((source) => source.url === url)),
    );
  };
}

test("snapshot updates preserve old files on failed download and detect tampering offline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "postal-filters-"));
  try {
    const fetcher = testFetcher();
    const first = await updateFilters(directory, fetcher);
    assert.deepEqual(await verifyFilters(directory), first);
    const before = await readFile(join(directory, "sources.json"), "utf8");
    await assert.rejects(
      updateFilters(directory, async (url) => {
        if (url.includes("easyprivacy")) throw new Error("Unavailable");
        return fetcher(url);
      }),
      /Unavailable/,
    );
    assert.equal(
      await readFile(join(directory, "sources.json"), "utf8"),
      before,
    );
    await verifyFilters(directory);
    await writeFile(
      join(directory, "easylist.txt"),
      `${fixture(officialSources[0])}\n||altered.test^`,
    );
    await assert.rejects(verifyFilters(directory), /integrity/);
    await updateFilters(directory, fetcher);
    first.sources[0].url = "https://mirror.example.test/list";
    await writeFile(join(directory, "sources.json"), JSON.stringify(first));
    await assert.rejects(verifyFilters(directory), /Unexpected/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TweetFeed updates verify the official published SHA-256 and leave other lists alone", async () => {
  assert.equal(
    TWEETFEED_MANIFEST_URL,
    "https://api.tweetfeed.live/v1/manifest",
  );
  await downloadTweetfeedManifest(async (url, options) => {
    assert.equal(url, TWEETFEED_MANIFEST_URL);
    assert.equal(options.redirect, "error");
    return new Response(JSON.stringify(tweetfeedManifestFor()));
  });
  await assert.rejects(
    downloadTweetfeedManifest(async () => new Response("", { status: 302 })),
    /failed/,
  );
  await assert.rejects(
    downloadTweetfeedManifest(
      async () =>
        new Response(JSON.stringify({ schema_version: 1, artifacts: [] })),
    ),
    /checksum is missing|Unexpected/,
  );

  const domains = tweetfeedSources()[0];
  const expected = publishedTweetfeedChecksum(tweetfeedManifestFor(), domains);
  await assert.rejects(
    downloadSource(domains, async () => new Response(fixture(domains)), {
      ...expected,
      sha256: "a".repeat(64),
    }),
    /checksum/,
  );

  const directory = await mkdtemp(join(tmpdir(), "postal-tweetfeed-"));
  try {
    await updateFilters(directory, testFetcher());
    const easylist = await readFile(join(directory, "easylist.txt"));
    const beforeDomains = await readFile(
      join(directory, "tweetfeed-domains.txt"),
    );
    const beforeManifest = await readFile(
      join(directory, "sources.json"),
      "utf8",
    );

    await assert.rejects(
      updateTweetfeedFilters(directory, async (url) => {
        if (url === TWEETFEED_MANIFEST_URL) {
          const published = tweetfeedManifestFor();
          published.artifacts[0].sha256 = "b".repeat(64);
          return new Response(JSON.stringify(published));
        }
        return testFetcher()(url);
      }),
      /checksum/,
    );
    assert.equal(
      await readFile(join(directory, "sources.json"), "utf8"),
      beforeManifest,
    );
    assert.deepEqual(
      await readFile(join(directory, "tweetfeed-domains.txt")),
      beforeDomains,
    );

    const extra = ["evil.test", "phish.test", "malware.test", "new.test"];
    const nextDomains = Buffer.from(
      `# TweetFeed blocklist - test\n# Window: 30 days\n# Entries: ${extra.length}\n# Updated: 2026-09-10T00:00:00Z\n# License: CC0\n# Source: ${domains.url}\n# https://tweetfeed.live\n# Community-reported IOCs. Use at your own risk.\n\n${extra.join("\n")}\n`,
    );
    const updated = await updateTweetfeedFilters(directory, async (url) => {
      if (url === TWEETFEED_MANIFEST_URL) {
        const published = tweetfeedManifestFor();
        published.artifacts[0] = {
          ...published.artifacts[0],
          bytes: nextDomains.length,
          rows: extra.length,
          sha256: createHash("sha256").update(nextDomains).digest("hex"),
        };
        return new Response(JSON.stringify(published));
      }
      if (url === domains.url) return new Response(nextDomains);
      return testFetcher()(url);
    });
    assert.deepEqual(await readFile(join(directory, "easylist.txt")), easylist);
    assert.notDeepEqual(
      await readFile(join(directory, "tweetfeed-domains.txt")),
      beforeDomains,
    );
    const recorded = updated.sources.find(
      (source) => source.file === domains.file,
    );
    assert.equal(recorded.entries, extra.length);
    assert.equal(recorded.publishedSha256, recorded.sha256);
    assert.equal(
      recorded.sha256,
      createHash("sha256").update(nextDomains).digest("hex"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checked-in filter snapshots match their official source manifest", async () => {
  await verifyFilters();
});

test("cargo notices document official EasyList and TweetFeed attribution", async () => {
  const notices = await readFile(
    new URL("./generate-cargo-licenses.js", import.meta.url),
    "utf8",
  );
  assert.match(notices, /EasyList and EasyPrivacy/);
  assert.match(notices, /https:\/\/easylist\.to\//);
  assert.match(notices, /Creative Commons Attribution-ShareAlike 3.0 Unported/);
  assert.match(notices, /LICENSE-CC-BY-SA-3.0\.txt/);
  assert.match(notices, /TweetFeed/);
  assert.match(notices, /https:\/\/tweetfeed\.live\//);
  assert.match(notices, /CC0 1.0/);
  assert.match(notices, /LICENSE-CC0-1.0\.txt/);
  assert.doesNotMatch(notices, /OpenPhish|Safe Browsing|adguard\.txt/);
});
