// Puts the server-rendered page into dist/index.html, then removes the temporary SSR bundle.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const site = fileURLToPath(new URL("..", import.meta.url));
const ssrDir = `${site}.ssr`;
const { render } = await import(`${ssrDir}/entry-server.js`);
const file = `${site}dist/index.html`;
const html = readFileSync(file, "utf8");
const marker = '<div id="root"></div>';
if (!html.includes(marker)) throw new Error("prerender: #root placeholder not found in dist/index.html");
writeFileSync(file, html.replace(marker, `<div id="root">${render()}</div>`));
rmSync(ssrDir, { recursive: true, force: true });
console.log("prerendered dist/index.html");
