import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const files = ["index.html", "app.js", "styles.css", "_headers", "_redirects"];

if (!existsSync("public")) {
  await mkdir("public", { recursive: true });
}

for (const file of files) {
  if (!existsSync(`public/${file}`) && existsSync(file)) {
    await copyFile(file, `public/${file}`);
  }
}
