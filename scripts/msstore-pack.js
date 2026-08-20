import { cp, mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ensureReleaseDir,
  json,
  process,
  requireEnv,
  root,
  run,
  writeFile,
} from "./_utils.js";

if (process.platform !== "win32")
  throw new Error(
    "Microsoft Store packaging must run on Windows with makeappx.exe available.",
  );
requireEnv([
  "MSSTORE_IDENTITY_NAME",
  "MSSTORE_PUBLISHER",
  "MSSTORE_PUBLISHER_DISPLAY_NAME",
]);
const pkg = await json(join(root, "package.json"));
const numeric = pkg.version.match(/^(\d+)\.(\d+)\.(\d+)/);
if (!numeric) throw new Error("Package version is invalid.");
const msixVersion = `${numeric[1]}.${numeric[2]}.${numeric[3]}.0`;
const requested = process.argv[2];
const arches = requested ? [requested] : ["x64", "arm64"];
const storeRoot = join(root, "msstore");
await rm(storeRoot, { recursive: true, force: true });
await mkdir(storeRoot, { recursive: true });
const packages = [];
for (const arch of arches) {
  if (!matchesArch(arch))
    throw new Error(`Unsupported Store architecture: ${arch}`);
  const rustTarget =
    arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const sourceExe = join(
    root,
    "src-tauri/target",
    rustTarget,
    "release/postal-snap.exe",
  );
  const stage = join(storeRoot, arch);
  await mkdir(join(stage, "Assets"), { recursive: true });
  await cp(sourceExe, join(stage, "PostalSnap.exe"));
  for (const name of [
    "StoreLogo.png",
    "Square44x44Logo.png",
    "Square150x150Logo.png",
  ]) {
    await cp(join(root, "src-tauri/icons", name), join(stage, "Assets", name));
  }
  for (const name of [
    "THIRD_PARTY_NOTICES.npm.txt",
    "THIRD_PARTY_NOTICES.cargo.txt",
  ]) {
    await cp(join(root, name), join(stage, name));
  }
  await writeFile(join(stage, "AppxManifest.xml"), manifest(arch, msixVersion));
  const output = join(storeRoot, `PostalSnap_${msixVersion}_${arch}.msix`);
  await run("makeappx.exe", ["pack", "/d", stage, "/p", output, "/o"]);
  packages.push(output);
}
const release = await ensureReleaseDir();
if (packages.length === 2) {
  const bundleInput = join(storeRoot, "bundle-input");
  await mkdir(bundleInput, { recursive: true });
  for (const packagePath of packages) {
    await cp(packagePath, join(bundleInput, basename(packagePath)));
  }
  await run("makeappx.exe", [
    "bundle",
    "/d",
    bundleInput,
    "/p",
    join(release, `PostalSnap_${msixVersion}.msixbundle`),
    "/o",
  ]);
} else {
  await cp(
    packages[0],
    join(release, `PostalSnap_${msixVersion}_${arches[0]}.msix`),
  );
}

function matchesArch(value) {
  return value === "x64" || value === "arm64";
}
function xml(value) {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[char],
  );
}
function manifest(arch, version) {
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
 xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
 xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
 IgnorableNamespaces="uap rescap">
 <Identity Name="${xml(process.env.MSSTORE_IDENTITY_NAME)}" Publisher="${xml(process.env.MSSTORE_PUBLISHER)}" Version="${version}" ProcessorArchitecture="${arch}" />
 <Properties><DisplayName>Postal Snap</DisplayName><PublisherDisplayName>${xml(process.env.MSSTORE_PUBLISHER_DISPLAY_NAME)}</PublisherDisplayName><Logo>Assets\\StoreLogo.png</Logo></Properties>
 <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19045.0" MaxVersionTested="10.0.26100.0" /></Dependencies>
 <Resources><Resource Language="en-US" /></Resources>
 <Applications><Application Id="PostalSnap" Executable="PostalSnap.exe" EntryPoint="Windows.FullTrustApplication">
  <uap:VisualElements DisplayName="Postal Snap" Description="Easy, secure email without clutter" BackgroundColor="#176caa" Square44x44Logo="Assets\\Square44x44Logo.png" Square150x150Logo="Assets\\Square150x150Logo.png" />
  <Extensions><uap:Extension Category="windows.protocol"><uap:Protocol Name="mailto"><uap:DisplayName>Postal Snap</uap:DisplayName></uap:Protocol></uap:Extension></Extensions>
 </Application></Applications>
 <Capabilities><Capability Name="internetClient" /><rescap:Capability Name="runFullTrust" /></Capabilities>
</Package>\n`;
}
