import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

const [sourceHtml, styles, app] = await Promise.all([
  readFile(join(projectRoot, "frontend", "index.html"), "utf8"),
  readFile(join(projectRoot, "frontend", "styles.css"), "utf8"),
  readFile(join(projectRoot, "frontend", "app.js"), "utf8"),
]);

// The public page is opened directly from a browser bookmark.  Give its
// JavaScript and CSS a content-derived name so a freshly loaded HTML document
// can never reuse a previous deployment's application shell.
const assetVersion = createHash("sha256")
  .update(sourceHtml)
  .update(styles)
  .update(app)
  .digest("hex")
  .slice(0, 12);
const styleFilename = `styles.${assetVersion}.css`;
const appFilename = `app.${assetVersion}.js`;

await Promise.all([
  writeFile(join(outputDirectory, styleFilename), styles, "utf8"),
  writeFile(join(outputDirectory, appFilename), app, "utf8"),
]);

const netlifyHtml = sourceHtml
  .replace('href="/frontend/styles.css"', `href="./${styleFilename}"`)
  .replace('<script src="/frontend/app.js" defer></script>', `<script src="./${appFilename}" defer></script>`);

if (netlifyHtml === sourceHtml || netlifyHtml.includes("TRAVELOPS_STATIC_DEMO")) {
  throw new Error("Netlify build could not rewrite the frontend asset paths safely.");
}

await writeFile(join(outputDirectory, "index.html"), netlifyHtml, "utf8");
console.log(`Netlify API demo written to ${outputDirectory} (assets ${assetVersion})`);
