import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, win32 as path } from "node:path";
import test from "node:test";
import { root } from "./_utils.js";
import {
  launchVsDevShellPath,
  openVsDevShell,
  resolveVsDevShellLauncher,
  vsDevShellPowerShellArgs,
  vswherePath,
  windowsPowerShellPath,
} from "./open-vs-dev-shell.js";

const env = {
  SystemRoot: "C:\\Windows",
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
};

function launchPath(installPath) {
  return launchVsDevShellPath(installPath);
}

test("open-vs-dev-shell avoids the broken ProgramFiles(x86) interpolation", async () => {
  const source = await readFile(
    join(root, "scripts/open-vs-dev-shell.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /\$env:ProgramFiles\(x86\)/);
  assert.doesNotMatch(source, /Enter-VsDevShell/);
  assert.doesNotMatch(source, /DevShell\.dll/);
  assert.match(source, /\["ProgramFiles\(x86\)"\]/);
  assert.match(source, /Launch-VsDevShell\.ps1/);
  assert.match(source, /WindowsPowerShell/);
  assert.match(source, /-SkipAutomaticLocation/);
});

test("package.json compiler scripts keep the VS dev-shell entrypoint", async () => {
  const packageJson = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  assert.equal(packageJson.scripts.wc, "npm run win-compiler:x64");
  assert.equal(
    packageJson.scripts["win-compiler:x64"],
    "node scripts/open-vs-dev-shell.js x64",
  );
  assert.equal(
    packageJson.scripts["win-compiler:arm64"],
    "node scripts/open-vs-dev-shell.js arm64",
  );
});

test("vswhere uses the ProgramFiles(x86) environment key", () => {
  assert.equal(
    vswherePath(env),
    "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe",
  );
  assert.equal(
    windowsPowerShellPath(env),
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
});

test("x64 and arm64 launch args match IYERIS Launch-VsDevShell.ps1", () => {
  const launch =
    "C:\\Program Files\\Microsoft Visual Studio\\18\\Professional\\Common7\\Tools\\Launch-VsDevShell.ps1";
  assert.deepEqual(vsDevShellPowerShellArgs(launch, "x64"), [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-NoExit",
    "-File",
    launch,
    "-SkipAutomaticLocation",
  ]);
  assert.deepEqual(vsDevShellPowerShellArgs(launch, "arm64"), [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-NoExit",
    "-File",
    launch,
    "-SkipAutomaticLocation",
    "-Arch",
    "arm64",
    "-HostArch",
    "amd64",
  ]);
});

test("resolveVsDevShellLauncher prefers vswhere then edition fallbacks", () => {
  const vswhere = vswherePath(env);
  const professional =
    "C:\\Program Files\\Microsoft Visual Studio\\18\\Professional";
  const community2022 =
    "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community";
  const files = new Set([
    vswhere,
    launchPath(professional),
    path.join(env.ProgramFiles, "Microsoft Visual Studio", "18"),
    path.join(env.ProgramFiles, "Microsoft Visual Studio", "2022"),
    launchPath(community2022),
  ]);

  assert.equal(
    resolveVsDevShellLauncher({
      env,
      exists: (candidate) => files.has(candidate),
      queryVswhere: () => professional,
      readDirectories: () => {
        throw new Error("vswhere should win");
      },
    }),
    launchPath(professional),
  );

  assert.equal(
    resolveVsDevShellLauncher({
      env,
      exists: (candidate) => files.has(candidate),
      queryVswhere: () => "",
      readDirectories: (directory) => {
        if (directory.endsWith("\\18")) return ["Professional"];
        if (directory.endsWith("\\2022")) return ["Community"];
        return [];
      },
    }),
    launchPath(professional),
  );
});

test("resolveVsDevShellLauncher finds Program Files (x86) VS 2022", () => {
  const install = path.join(
    env["ProgramFiles(x86)"],
    "Microsoft Visual Studio",
    "2022",
    "Enterprise",
  );
  const files = new Set([
    path.join(env["ProgramFiles(x86)"], "Microsoft Visual Studio", "2022"),
    launchPath(install),
  ]);
  assert.equal(
    resolveVsDevShellLauncher({
      env,
      exists: (candidate) => files.has(candidate),
      queryVswhere: () => {
        throw new Error("vswhere is absent");
      },
      readDirectories: (directory) =>
        directory.endsWith("\\2022") ? ["Enterprise"] : [],
    }),
    launchPath(install),
  );
});

test("openVsDevShell launches System32 powershell with -NoExit", () => {
  const launch =
    "C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise\\Common7\\Tools\\Launch-VsDevShell.ps1";
  const spawned = [];
  const result = openVsDevShell("arm64", {
    platform: "win32",
    env,
    exists: (candidate) =>
      candidate === vswherePath(env) || candidate === launch,
    queryVswhere: () =>
      "C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise",
    spawnSync: (command, args) => {
      spawned.push({ command, args });
      return { status: 0 };
    },
  });
  assert.equal(result.powershell, windowsPowerShellPath(env));
  assert.equal(result.launchPath, launch);
  assert.deepEqual(spawned[0].args, vsDevShellPowerShellArgs(launch, "arm64"));
  assert.equal(spawned[0].command, windowsPowerShellPath(env));
});

test("openVsDevShell stays Windows-only", () => {
  assert.throws(
    () => openVsDevShell("x64", { platform: "linux" }),
    /only available on Windows/,
  );
});
