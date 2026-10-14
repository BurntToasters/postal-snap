import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { root } from "./lib/paths.js";

export function rustCommands(source) {
  const block = source.match(/generate_handler!\[([\s\S]*?)\]/)?.[1];
  if (!block) throw new Error("No native command registration found");
  return new Set(
    [...block.matchAll(/(?:\w+::)+(\w+)/g)].map((match) => match[1]),
  );
}

export function mockCommands(source) {
  const file = ts.createSourceFile(
    "mock.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const commands = new Set();
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(file) === "Object.assign" &&
      node.arguments[0]?.getText(file) === "mock.handlers"
    ) {
      const object = node.arguments[1];
      if (!object || !ts.isObjectLiteralExpression(object))
        throw new Error("Unsupported mock registration");
      for (const property of object.properties) {
        if (!property.name || ts.isComputedPropertyName(property.name))
          throw new Error("Unsupported mock name");
        commands.add(property.name.text);
      }
    }
    if (
      ts.isCaseClause(node) &&
      ts.isStringLiteral(node.expression) &&
      !node.expression.text.startsWith("plugin:")
    )
      commands.add(node.expression.text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return commands;
}

export function checkContract(native, mocks, exceptions) {
  const errors = [];
  for (const command of mocks) {
    if (command.startsWith("plugin:")) continue;
    if (!native.has(command)) errors.push(`Stale mock: ${command}`);
  }
  for (const command of native) {
    if (!mocks.has(command) && !exceptions[command])
      errors.push(`Missing mock: ${command}`);
  }
  for (const command of Object.keys(exceptions)) {
    if (!native.has(command) || mocks.has(command))
      errors.push(`Stale exception: ${command}`);
  }
  return errors;
}

// These native-only operations require desktop integration evidence.
const exceptions = {
  connect_oauth_account:
    "Parked sign-in is disabled without the oauth Cargo feature.",
};

export function main() {
  const native = rustCommands(
    readFileSync(join(root, "src-tauri/src/main.rs"), "utf8"),
  );
  const mocks = new Set();
  const directory = join(root, "e2e/mock");
  for (const file of readdirSync(directory).filter((name) =>
    name.endsWith(".ts"),
  )) {
    for (const command of mockCommands(
      readFileSync(join(directory, file), "utf8"),
    ))
      mocks.add(command);
  }
  const errors = checkContract(native, mocks, exceptions);
  if (errors.length) {
    console.error(errors.join("\n"));
    return 1;
  }
  console.log(
    `IPC contract: ${native.size} native commands; ${Object.keys(exceptions).length} explicit coverage ${Object.keys(exceptions).length === 1 ? "gap" : "gaps"}.`,
  );
  return 0;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = main();
}
