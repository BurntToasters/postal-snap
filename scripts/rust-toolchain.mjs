#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import console from "node:console";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_TOOLCHAIN_FILE = fileURLToPath(
  new URL("../rust-toolchain.toml", import.meta.url),
);
const EXACT_CHANNEL = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const rustupCommand = process.platform === "win32" ? "rustup.exe" : "rustup";

function stripTomlComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === quote && line[index - 1] !== "\\") quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

function bracketDepth(value) {
  let depth = 0;
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
    }
  }
  return depth;
}

function parseTomlString(value, key, filePath) {
  const match = value.match(/^("(?:[^"\\]|\\.)*"|'[^']*')$/u);
  if (!match) {
    throw new Error(`Invalid string for ${key} in ${filePath}: ${value}`);
  }
  if (match[1].startsWith("'")) return match[1].slice(1, -1);
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`Invalid string for ${key} in ${filePath}: ${value}`, {
      cause: error,
    });
  }
}

function parseTomlArray(value, filePath) {
  const match = value.match(/^\[([\s\S]*)\]$/u);
  if (!match) {
    throw new Error(`Invalid components array in ${filePath}: ${value}`);
  }
  const body = match[1].trim();
  if (!body) return [];
  return [
    ...new Set(
      body
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => parseTomlString(entry, "components", filePath)),
    ),
  ];
}

export function readRustToolchainPin(filePath = DEFAULT_TOOLCHAIN_FILE) {
  let contents;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Rust toolchain pin not found: ${filePath}`, {
        cause: error,
      });
    }
    throw error;
  }

  const lines = contents.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  let section = null;
  let channel;
  let profile;
  let components;

  for (let index = 0; index < lines.length; index += 1) {
    const line = stripTomlComment(lines[index]).trim();
    if (!line) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/u);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    if (section !== "toolchain") continue;

    const equals = line.indexOf("=");
    if (equals <= 0) {
      throw new Error(
        `Invalid rust-toolchain.toml line ${index + 1}: ${lines[index].trim()}`,
      );
    }
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();

    if (key === "channel") {
      channel = parseTomlString(value, key, filePath);
    } else if (key === "profile") {
      profile = parseTomlString(value, key, filePath);
    } else if (key === "components") {
      while (
        value.startsWith("[") &&
        bracketDepth(value) > 0 &&
        index + 1 < lines.length
      ) {
        index += 1;
        value += `\n${stripTomlComment(lines[index])}`;
      }
      components = parseTomlArray(value, filePath);
    }
  }

  if (!channel) {
    throw new Error(`Missing [toolchain] channel in ${filePath}`);
  }
  if (!EXACT_CHANNEL.test(channel)) {
    throw new Error(
      `Rust toolchain channel must be an exact version, found "${channel}" in ${filePath}`,
    );
  }
  return { channel, profile, components: components ?? [] };
}

export function readPinnedRustToolchain(filePath = DEFAULT_TOOLCHAIN_FILE) {
  return readRustToolchainPin(filePath).channel;
}

function runRustup(args) {
  const result = spawnSync(rustupCommand, args, { stdio: "inherit" });
  if (result.error) {
    throw new Error(`Unable to run ${rustupCommand}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `rustup ${args.join(" ")} failed with exit code ${result.status}`,
    );
  }
}

const USAGE = `Usage: node scripts/rust-toolchain.mjs [print|--install|--target <triple...>]`;

function parseArguments(argv) {
  if (
    argv.some((arg) => arg === "--print" || arg === "print") &&
    argv.length > 1
  ) {
    throw new Error("--print cannot be combined with an action");
  }
  const [command, ...rest] = argv;
  if (!command || command === "--print" || command === "print") {
    return { action: "print" };
  }
  if (command === "--install" || command === "install") {
    if (rest.length > 0) {
      throw new Error("--install does not take arguments");
    }
    return { action: "install" };
  }
  if (command === "--target" || command === "target") {
    if (rest.length === 0) {
      throw new Error("--target requires at least one target triple");
    }
    return { action: "target", targets: rest };
  }
  if (command === "--help" || command === "-h") {
    return { action: "help" };
  }
  throw new Error(`Unknown argument: ${command}`);
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.action === "help") {
    console.log(USAGE);
    return;
  }

  const pin = readRustToolchainPin();
  if (options.action === "print") {
    console.log(pin.channel);
    return;
  }

  if (options.action === "install") {
    const args = ["toolchain", "install", pin.channel];
    if (pin.profile) args.push("--profile", pin.profile);
    if (pin.components.length > 0) {
      args.push("--component", pin.components.join(","));
    }
    runRustup(args);
    return;
  }

  runRustup(["target", "add", "--toolchain", pin.channel, ...options.targets]);
}

const isMainModule =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMainModule) {
  try {
    main();
  } catch (error) {
    console.error(`rust-toolchain: ${error.message}`);
    process.exitCode = 1;
  }
}
