import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(projectRoot, "dist-static-demo");
const allowedPrefix = `${projectRoot}${sep}`;

if (!outputDirectory.startsWith(allowedPrefix)) {
  throw new Error("Static build output must stay inside the project directory.");
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(join(outputDirectory, "data"), { recursive: true });

for (const filename of ["styles.css", "app.js", "static-demo-core.mjs", "browser-demo-adapter.js"]) {
  await copyFile(join(projectRoot, "frontend", filename), join(outputDirectory, filename));
}
await copyFile(
  join(projectRoot, "data", "attractions.json"),
  join(outputDirectory, "data", "attractions.json"),
);

const sourceHtml = await readFile(join(projectRoot, "frontend", "index.html"), "utf8");
const withStaticCss = sourceHtml.replace('href="/frontend/styles.css"', 'href="./styles.css"');
const staticScripts = `<script>
      window.TRAVELOPS_STATIC_DEMO = true;
      window.TravelOpsStaticDemoReady = import("./browser-demo-adapter.js");
    </script>
    <script src="./app.js" defer></script>`;
const staticHtml = withStaticCss.replace(
  '<script src="/frontend/app.js" defer></script>',
  staticScripts,
);

if (staticHtml === sourceHtml || !staticHtml.includes("TRAVELOPS_STATIC_DEMO")) {
  throw new Error("Static build could not rewrite the frontend asset paths.");
}

await writeFile(join(outputDirectory, "index.html"), staticHtml, "utf8");
console.log(`Static public demo written to ${outputDirectory}`);
