import { process, run } from "./_utils.js";
if (process.platform !== "win32")
  throw new Error(
    "Visual Studio developer shells are only available on Windows.",
  );
const arch = process.argv[2] ?? "x64";
const script = `$p=& "$env:ProgramFiles(x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath; Import-Module "$p\\Common7\\Tools\\Microsoft.VisualStudio.DevShell.dll"; Enter-VsDevShell -VsInstallPath $p -DevCmdArguments '-arch=${arch}'`;
await run("powershell.exe", ["-NoExit", "-NoProfile", "-Command", script]);
