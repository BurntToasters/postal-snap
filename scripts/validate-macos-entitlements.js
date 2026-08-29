import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { output, process, root } from "./_utils.js";

const PLIST_ELEMENTS = new Set([
  "array",
  "data",
  "date",
  "dict",
  "false",
  "integer",
  "key",
  "plist",
  "real",
  "string",
  "true",
]);
const TEXT_ELEMENTS = new Set([
  "data",
  "date",
  "integer",
  "key",
  "real",
  "string",
]);

function displayPath(path) {
  const relativePath = relative(root, path);
  return relativePath.startsWith("..") ? path : relativePath;
}

function invalidPlist(label, detail) {
  return new Error(`${label} is not a structurally valid XML plist: ${detail}`);
}

export function assertEntitlementsPlistEnvelope(source, path = "entitlements") {
  const label = displayPath(resolve(path));
  if (source.includes("\0")) {
    throw invalidPlist(label, "it contains a NUL byte.");
  }

  const tokenPattern =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<\/?[A-Za-z][^>]*>|[^<]+/gy;
  const stack = [];
  let offset = 0;
  let sawRoot = false;
  let closedRoot = false;
  let plistChildren = 0;

  while (offset < source.length) {
    tokenPattern.lastIndex = offset;
    const match = tokenPattern.exec(source);
    if (!match || match.index !== offset) {
      throw invalidPlist(label, `malformed markup near byte ${offset}.`);
    }
    offset = tokenPattern.lastIndex;
    const token = match[0];

    if (token.startsWith("<!--")) continue;
    if (token.startsWith("<?") || token.startsWith("<!DOCTYPE")) {
      if (sawRoot) {
        throw invalidPlist(label, "XML declarations must precede the root.");
      }
      continue;
    }
    if (!token.startsWith("<")) {
      if (token.trim() && !TEXT_ELEMENTS.has(stack.at(-1))) {
        throw invalidPlist(label, "text appears outside a plist value.");
      }
      continue;
    }

    const tag = token.match(/^<(\/)?([A-Za-z][\w.-]*)([^>]*)>$/);
    if (!tag) throw invalidPlist(label, "a tag is malformed.");
    const [, closingMarker, name, suffix] = tag;
    if (!PLIST_ELEMENTS.has(name)) {
      throw invalidPlist(label, `unsupported <${name}> element.`);
    }

    const closing = Boolean(closingMarker);
    const selfClosing = !closing && /\/\s*$/.test(suffix);
    const attributes = selfClosing
      ? suffix.replace(/\/\s*$/, "").trim()
      : suffix.trim();
    if (closing && suffix.trim()) {
      throw invalidPlist(label, `closing </${name}> tag has extra content.`);
    }
    if (attributes && name !== "plist") {
      throw invalidPlist(label, `<${name}> must not have attributes.`);
    }
    if (
      name === "plist" &&
      attributes &&
      !/^version\s*=\s*["']1\.0["']$/.test(attributes)
    ) {
      throw invalidPlist(label, "the plist version attribute must be 1.0.");
    }

    if (closing) {
      const expected = stack.pop();
      if (expected !== name) {
        throw invalidPlist(
          label,
          `closing </${name}> does not match <${expected ?? "none"}>.`,
        );
      }
      if (name === "plist") closedRoot = true;
      continue;
    }

    if (closedRoot) {
      throw invalidPlist(label, "content appears after the plist root.");
    }
    if (stack.length === 0) {
      if (sawRoot || name !== "plist" || selfClosing) {
        throw invalidPlist(
          label,
          "the single root must be a nonempty <plist>.",
        );
      }
      sawRoot = true;
    } else if (stack.length === 1 && stack[0] === "plist") {
      plistChildren += 1;
      if (name !== "dict") {
        throw invalidPlist(label, "the plist root value must be a dictionary.");
      }
    }
    if (!selfClosing) stack.push(name);
  }

  if (stack.length) {
    throw invalidPlist(label, `unclosed <${stack.at(-1)}> element.`);
  }
  if (!sawRoot || !closedRoot || plistChildren !== 1) {
    throw invalidPlist(
      label,
      "it must contain exactly one complete plist dictionary.",
    );
  }
}

export async function validateEntitlementsPlist(
  path,
  { platform = process.platform, lint = output } = {},
) {
  const absolutePath = resolve(path);
  const source = await readFile(absolutePath, "utf8");
  assertEntitlementsPlistEnvelope(source, absolutePath);

  if (platform === "darwin") {
    try {
      await lint("/usr/bin/plutil", ["-lint", absolutePath]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Invalid macOS entitlements ${displayPath(absolutePath)}: ${detail}`,
        { cause: error },
      );
    }
  }

  return absolutePath;
}

export async function validateRepositoryMacosEntitlements() {
  return Promise.all([
    validateEntitlementsPlist(joinTauriPath("entitlements.plist")),
    validateEntitlementsPlist(joinTauriPath("entitlements.mas.plist")),
  ]);
}

function joinTauriPath(name) {
  return resolve(root, "src-tauri", name);
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  const paths = await validateRepositoryMacosEntitlements();
  console.log(`Validated ${paths.length} macOS entitlement plists.`);
}
