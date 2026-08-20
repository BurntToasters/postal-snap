import { run } from "./_utils.js";
await run("npm", ["run", "tauri", "--", "icon", "src-tauri/icons/icon.svg"]);
