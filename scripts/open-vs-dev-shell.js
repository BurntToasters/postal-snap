import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { win32 as path } from "node:path";
import process from "node:process";

const VS_VERSION_FOLDERS = ["18", "2026", "2022"];

export function windowsPowerShellPath(env = process.env) {
  return path.join(
    env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

export function vswherePath(env = process.env) {
  // Node equivalent of PowerShell ${env:ProgramFiles(x86)}. Do not read
  // ProgramFiles and append "(x86)"; that is a different environment variable.
  const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  return path.join(
    programFilesX86,
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
}

export function launchVsDevShellPath(installPath) {
  return path.join(installPath, "Common7", "Tools", "Launch-VsDevShell.ps1");
}

export function vsDevShellPowerShellArgs(launchPath, architecture) {
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-NoExit",
    "-File",
    launchPath,
    "-SkipAutomaticLocation",
  ];
  if (architecture === "arm64")
    args.push("-Arch", "arm64", "-HostArch", "amd64");
  return args;
}

function defaultReadDirectories(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function defaultQueryVswhere(vswhere) {
  const result = spawnSync(
    vswhere,
    [
      "-latest",
      "-prerelease",
      "-products",
      "*",
      "-property",
      "installationPath",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error || result.status) return "";
  return String(result.stdout || "").trim();
}

export function resolveVsDevShellLauncher({
  env = process.env,
  exists = existsSync,
  readDirectories = defaultReadDirectories,
  queryVswhere = defaultQueryVswhere,
} = {}) {
  const vswhere = vswherePath(env);
  if (exists(vswhere)) {
    const installPath = queryVswhere(vswhere);
    if (installPath) {
      const launch = launchVsDevShellPath(installPath);
      if (exists(launch)) return launch;
    }
  }

  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const roots = VS_VERSION_FOLDERS.map((version) =>
    path.join(programFiles, "Microsoft Visual Studio", version),
  );
  roots.push(path.join(programFilesX86, "Microsoft Visual Studio", "2022"));

  for (const root of roots) {
    if (!exists(root)) continue;
    try {
      for (const edition of readDirectories(root)) {
        const launch = launchVsDevShellPath(path.join(root, edition));
        if (exists(launch)) return launch;
      }
    } catch {
      continue;
    }
  }

  throw new Error(
    "Could not find Launch-VsDevShell.ps1. Install Visual Studio 2022 or 2026 with the C++ workload.",
  );
}

export function openVsDevShell(architecture = "x64", options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error(
      "Visual Studio developer shells are only available on Windows.",
    );
  }

  const arch = architecture === "arm64" ? "arm64" : "x64";
  const env = options.env ?? process.env;
  const launchPath = resolveVsDevShellLauncher({ ...options, env });
  const powershell = windowsPowerShellPath(env);
  const args = vsDevShellPowerShellArgs(launchPath, arch);
  const spawn = options.spawnSync ?? spawnSync;
  const result = spawn(powershell, args, {
    stdio: "inherit",
    windowsHide: false,
  });
  if (result?.error) {
    throw new Error(
      `Failed to open Visual Studio developer shell: ${result.error.message}`,
    );
  }
  const status = result?.status ?? 0;
  if (options.spawnSync) return { powershell, args, status, launchPath };
  if (status) process.exit(status);
}

if (process.argv[1]?.endsWith("open-vs-dev-shell.js")) {
  openVsDevShell(process.argv[2]);
}
