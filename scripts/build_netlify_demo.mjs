import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(projectRoot, "dist-netlify-demo");
const allowedPrefix = `${projectRoot}${sep}`;

if (!outputDirectory.startsWith(allowedPrefix)) {
  throw new Error("Netlify build output must stay inside the project directory.");
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await copyFile(join(projectRoot, "frontend", "styles.css"), join(outputDirectory, "styles.css"));
await copyFile(join(projectRoot, "frontend", "app.js"), join(outputDirectory, "app.js"));

const sourceHtml = await readFile(join(projectRoot, "frontend", "index.html"), "utf8");
const netlifyHtml = sourceHtml
  .replace('href="/frontend/styles.css"', 'href="./styles.css"')
  .replace('<script src="/frontend/app.js" defer></script>', '<script src="./app.js" defer></script>');

if (netlifyHtml === sourceHtml || netlifyHtml.includes("TRAVELOPS_STATIC_DEMO")) {
  throw new Error("Netlify build could not rewrite the frontend asset paths safely.");
}

await writeFile(join(outputDirectory, "index.html"), netlifyHtml, "utf8");
console.log(`Netlify API demo written to ${outputDirectory}`);
