import { run } from "./_utils.js";
await run("flatpak", [
  "remote-add",
  "--user",
  "--if-not-exists",
  "flathub",
  "https://flathub.org/repo/flathub.flatpakrepo",
]);
await run("flatpak", [
  "install",
  "--user",
  "-y",
  "flathub",
  "org.gnome.Platform//49",
  "org.gnome.Sdk//49",
]);
