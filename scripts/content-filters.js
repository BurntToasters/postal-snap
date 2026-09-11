import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { root } from "./lib/paths.js";

export const filterDirectory = join(root, "src-tauri", "filters");
export const TWEETFEED_MANIFEST_URL = "https://api.tweetfeed.live/v1/manifest";
export const officialSources = [
  {
    kind: "easylist",
    file: "easylist.txt",
    title: "EasyList",
    header: "[Adblock Plus 2.0]",
    url: "https://easylist.to/easylist/easylist.txt",
  },
  {
    kind: "easylist",
    file: "easyprivacy.txt",
    title: "EasyPrivacy",
    header: "[Adblock Plus 1.1]",
    url: "https://easylist.to/easylist/easyprivacy.txt",
  },
  {
    kind: "license-cc-by-sa",
    file: "LICENSE-CC-BY-SA-3.0.txt",
    url: "https://creativecommons.org/licenses/by-sa/3.0/legalcode.txt",
  },
  {
    kind: "tweetfeed-domains",
    file: "tweetfeed-domains.txt",
    url: "https://api.tweetfeed.live/v1/blocklist/domains.txt",
  },
  {
    kind: "tweetfeed-urls",
    file: "tweetfeed-urls.txt",
    url: "https://api.tweetfeed.live/v1/blocklist/urls.txt",
  },
  {
    kind: "license-cc0",
    file: "LICENSE-CC0-1.0.txt",
    url: "https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt",
  },
];
const maxBytes = 10 * 1024 * 1024;
const maxManifestBytes = 2 * 1024 * 1024;

export function isTweetfeedList(source) {
  return (
    source.kind === "tweetfeed-domains" || source.kind === "tweetfeed-urls"
  );
}

export function tweetfeedSources() {
  return officialSources.filter(isTweetfeedList);
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBoundedBody(response, limit) {
  if (!response.ok || !response.body)
    throw new Error("Filter source download failed.");
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body.cancel();
    throw new Error("Filter source is too large.");
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error("Filter source is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function publishedTweetfeedChecksum(manifest, source) {
  if (!isTweetfeedList(source)) throw new Error("Unexpected filter source.");
  if (
    manifest.schema_version !== 1 ||
    !Array.isArray(manifest.artifacts) ||
    (manifest.api_base && manifest.api_base !== "https://api.tweetfeed.live")
  ) {
    throw new Error("Unexpected TweetFeed manifest.");
  }
  const artifact = manifest.artifacts.find(
    (entry) => entry.api_url === source.url,
  );
  if (
    !artifact ||
    typeof artifact.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    !Number.isInteger(artifact.bytes) ||
    artifact.bytes <= 0 ||
    !Number.isInteger(artifact.rows) ||
    artifact.rows <= 0
  ) {
    throw new Error("Official TweetFeed checksum is missing.");
  }
  return {
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    rows: artifact.rows,
    updatedAt: artifact.updated_at,
  };
}

export async function downloadTweetfeedManifest(fetcher = fetch) {
  const response = await fetcher(TWEETFEED_MANIFEST_URL, {
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  const bytes = await readBoundedBody(response, maxManifestBytes);
  const manifest = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  for (const source of tweetfeedSources()) {
    publishedTweetfeedChecksum(manifest, source);
  }
  return manifest;
}

function tweetfeedEntries(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function validateTweetfeed(source, text) {
  if (
    !text.startsWith("# TweetFeed blocklist") ||
    !text.includes("# Window: 30 days") ||
    !text.includes("# License: CC0") ||
    !text.includes(`# Source: ${source.url}`) ||
    !text.includes("# https://tweetfeed.live")
  ) {
    throw new Error("Unexpected filter source header.");
  }
  const updated = text.match(
    /^# Updated: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\r?$/m,
  )?.[1];
  const entriesHeader = text.match(/^# Entries: (\d+)\r?$/m)?.[1];
  const entries = tweetfeedEntries(text);
  if (!updated || !entriesHeader || Number(entriesHeader) !== entries.length) {
    throw new Error("Incomplete filter source.");
  }
  if (source.kind === "tweetfeed-domains") {
    if (
      entries.some(
        (entry) =>
          /[\s/:?#]/.test(entry) || !entry.includes(".") || entry.length > 253,
      )
    ) {
      throw new Error("Unexpected filter source header.");
    }
  } else if (
    entries.some(
      (entry) => !/^https?:\/\/\S+$/i.test(entry) || entry.length > 2048,
    )
  ) {
    throw new Error("Unexpected filter source header.");
  }
  return { updated, entries: Number(entriesHeader) };
}

export function validateSource(source, bytes) {
  if (!bytes.length || bytes.length > maxBytes)
    throw new Error("Invalid filter source size.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (source.kind === "easylist") {
    if (
      !text.startsWith(`${source.header}\n`) ||
      !text.includes(`! Title: ${source.title}\n`)
    ) {
      throw new Error("Unexpected filter source header.");
    }
    const version = text.match(/^! Version: (\d{12})\r?$/m)?.[1];
    const commit = text.match(/^! Commit: ([a-f0-9]{40})\r?$/m)?.[1];
    if (!version || !commit || text.split("\n").length < 1000) {
      throw new Error("Incomplete filter source.");
    }
    return { version, commit };
  }
  if (source.kind === "license-cc-by-sa") {
    if (
      !text.includes("Attribution-ShareAlike 3.0 Unported") ||
      text.length < 10000
    ) {
      throw new Error("Unexpected filter license.");
    }
    return {};
  }
  if (source.kind === "license-cc0") {
    if (!text.includes("CC0 1.0 Universal") || text.length < 2000) {
      throw new Error("Unexpected filter license.");
    }
    return {};
  }
  if (source.kind === "tweetfeed-domains" || source.kind === "tweetfeed-urls") {
    return validateTweetfeed(source, text);
  }
  throw new Error("Unexpected filter source.");
}

export async function downloadSource(source, fetcher = fetch, expected) {
  if (
    !officialSources.some(
      (entry) => entry.url === source.url && entry.file === source.file,
    )
  ) {
    throw new Error("Only official filter sources are allowed.");
  }
  const response = await fetcher(source.url, {
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  const bytes = await readBoundedBody(response, maxBytes);
  const metadata = validateSource(source, bytes);
  const sha256 = sha256Hex(bytes);
  if (
    expected &&
    (expected.sha256 !== sha256 ||
      expected.bytes !== bytes.length ||
      expected.rows !== metadata.entries)
  ) {
    throw new Error("Official filter checksum mismatch.");
  }
  return {
    bytes,
    metadata: expected
      ? { ...metadata, publishedSha256: expected.sha256 }
      : metadata,
  };
}

export async function verifyFilters(directory = filterDirectory) {
  const manifest = JSON.parse(
    await readFile(join(directory, "sources.json"), "utf8"),
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.sources.length !== officialSources.length
  ) {
    throw new Error("Invalid filter source manifest.");
  }
  for (const source of officialSources) {
    const recorded = manifest.sources.find(
      (entry) => entry.file === source.file,
    );
    if (!recorded || recorded.url !== source.url)
      throw new Error("Unexpected filter source.");
    const bytes = await readFile(join(directory, source.file));
    const metadata = validateSource(source, bytes);
    const sha256 = sha256Hex(bytes);
    if (
      recorded.sha256 !== sha256 ||
      (recorded.publishedSha256 && recorded.publishedSha256 !== sha256) ||
      recorded.bytes !== bytes.length ||
      recorded.version !== metadata.version ||
      recorded.commit !== metadata.commit ||
      recorded.updated !== metadata.updated ||
      recorded.entries !== metadata.entries
    ) {
      throw new Error("Filter source integrity check failed.");
    }
  }
  return manifest;
}

function sourceRecord(source, bytes, metadata) {
  return {
    ...source,
    ...metadata,
    bytes: bytes.length,
    sha256: sha256Hex(bytes),
  };
}

async function writeSnapshots(directory, downloads, manifest) {
  await mkdir(directory, { recursive: true });
  for (const { source, bytes } of downloads) {
    await writeFile(join(directory, `${source.file}.tmp`), bytes);
    await rename(
      join(directory, `${source.file}.tmp`),
      join(directory, source.file),
    );
  }
  await writeFile(
    join(directory, "sources.json.tmp"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await rename(
    join(directory, "sources.json.tmp"),
    join(directory, "sources.json"),
  );
}

export async function updateFilters(
  directory = filterDirectory,
  fetcher = fetch,
) {
  const published = await downloadTweetfeedManifest(fetcher);
  const downloads = [];
  for (const source of officialSources) {
    const expected = isTweetfeedList(source)
      ? publishedTweetfeedChecksum(published, source)
      : undefined;
    downloads.push({
      source,
      ...(await downloadSource(source, fetcher, expected)),
    });
  }
  const manifest = {
    schemaVersion: 1,
    downloadedAt: new Date().toISOString(),
    tweetfeedManifestGeneratedAt: published.generated_at,
    sources: downloads.map(({ source, bytes, metadata }) =>
      sourceRecord(source, bytes, metadata),
    ),
  };
  await writeSnapshots(directory, downloads, manifest);
  return verifyFilters(directory);
}

export async function updateTweetfeedFilters(
  directory = filterDirectory,
  fetcher = fetch,
) {
  await verifyFilters(directory);
  const existing = JSON.parse(
    await readFile(join(directory, "sources.json"), "utf8"),
  );
  const otherFiles = await Promise.all(
    officialSources
      .filter((source) => !isTweetfeedList(source))
      .map(async (source) => [
        source.file,
        await readFile(join(directory, source.file)),
      ]),
  );
  const published = await downloadTweetfeedManifest(fetcher);
  const downloads = [];
  for (const source of tweetfeedSources()) {
    downloads.push({
      source,
      ...(await downloadSource(
        source,
        fetcher,
        publishedTweetfeedChecksum(published, source),
      )),
    });
  }
  const byFile = new Map(
    existing.sources.map((source) => [source.file, source]),
  );
  for (const { source, bytes, metadata } of downloads) {
    byFile.set(source.file, sourceRecord(source, bytes, metadata));
  }
  const manifest = {
    ...existing,
    tweetfeedDownloadedAt: new Date().toISOString(),
    tweetfeedManifestGeneratedAt: published.generated_at,
    sources: officialSources.map((source) => {
      const recorded = byFile.get(source.file);
      if (!recorded || recorded.url !== source.url) {
        throw new Error("Unexpected filter source.");
      }
      return recorded;
    }),
  };
  await writeSnapshots(directory, downloads, manifest);
  const next = await verifyFilters(directory);
  for (const [file, before] of otherFiles) {
    if (!(await readFile(join(directory, file))).equals(before)) {
      throw new Error("TweetFeed update must not rewrite other filter files.");
    }
  }
  return next;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  if (
    args.length !== 1 ||
    !["--check", "--update", "--update-tweetfeed"].includes(args[0])
  ) {
    throw new Error("Use --check, --update, or --update-tweetfeed.");
  }
  const manifest =
    args[0] === "--update"
      ? await updateFilters()
      : args[0] === "--update-tweetfeed"
        ? await updateTweetfeedFilters()
        : await verifyFilters();
  const tweetfeed = manifest.sources.filter(
    (source) =>
      source.kind === "tweetfeed-domains" || source.kind === "tweetfeed-urls",
  );
  if (args[0] === "--update-tweetfeed") {
    console.log(
      `Updated ${tweetfeed.length} official TweetFeed snapshots and verified published SHA-256 checksums.`,
    );
  } else {
    console.log(
      `Verified ${manifest.sources.length} official filter source files.`,
    );
  }
}
