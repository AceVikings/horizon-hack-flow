#!/usr/bin/env node
// Package Flow into installers: node scripts/package.mjs [--mac] [--win]   (default: --mac)
// 1. electron-vite build; 2. stage a minimal app dir (out/, icon, ws) so electron-builder never walks the pnpm
// workspace; 3. bundle the daemon and owner service with esbuild (workspace packages from src) into
// <Resources>/backend, with better-sqlite3 prebuilt for Electron per target; 4. electron-builder (ad-hoc signed on
// macOS). Output: <repo>/.context/release. The app runs the bundles with Electron's Node (lifecycle.ts BACKEND).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(desktop, "../..");
const work = join(repo, ".context", "pack");
const release = join(repo, ".context", "release");
const req = createRequire(join(desktop, "package.json"));
const esbuild = createRequire(req.resolve("vite"))("esbuild");
const electronVersion = req("electron/package.json").version;
const args = process.argv.slice(2);
const targets = [...(args.includes("--mac") || !args.includes("--win") ? [["darwin", "arm64"]] : []), ...(args.includes("--win") ? [["win32", "x64"]] : [])];
const run = (cmd, a, cwd = desktop) => execFileSync(cmd, a, { cwd, stdio: "inherit" });

// ---- 1. renderer/main/preload
run(join(desktop, "node_modules/.bin/electron-vite"), ["build"]);

// ---- 2. staged app dir
const app = join(work, "app");
rmSync(app, { recursive: true, force: true });
mkdirSync(join(app, "build"), { recursive: true });
cpSync(join(desktop, "out"), join(app, "out"), { recursive: true });
cpSync(join(desktop, "build/icon.png"), join(app, "build/icon.png"));
const wsDir = dirname(realpathSync(req.resolve("ws/package.json")));
cpSync(wsDir, join(app, "node_modules/ws"), { recursive: true, dereference: true });
const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
writeFileSync(join(app, "package.json"), JSON.stringify({ name: "flow", productName: "Flow", version: pkg.version, description: "Flow", author: "Flow", license: pkg.license, main: "out/main/index.js", dependencies: { ws: JSON.parse(readFileSync(join(wsDir, "package.json"), "utf8")).version } }, null, 2));
writeFileSync(
  join(app, "afterpack.cjs"),
  `const { execFileSync } = require("node:child_process");
exports.default = async (ctx) => {
  if (ctx.electronPlatformName !== "darwin") return;
  const p = require("node:path").join(ctx.appOutDir, ctx.packager.appInfo.productFilename + ".app");
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", p], { stdio: "inherit" });
};\n`,
);

// ---- 3. backend bundles
const wsDirs = Object.fromEntries(
  ["apps", "packages", "agents"].flatMap((g) =>
    readdirSync(join(repo, g))
      .filter((d) => existsSync(join(repo, g, d, "package.json")))
      .map((d) => [JSON.parse(readFileSync(join(repo, g, d, "package.json"), "utf8")).name, join(repo, g, d)]),
  ),
);
const rewrites = [
  // file-relative resources a single bundle would collapse onto one path
  ["agents/trader/src/index.ts", '"../PROMPT.md"', '"./prompts/trader.md"'],
  ["agents/chat/src/runner.ts", '"../PROMPT.md"', '"./prompts/chat.md"'],
  ["packages/journal/src/migrate.ts", '"../migrations/"', '"./migrations/"'],
];
const workspacePlugin = {
  name: "ate-workspace",
  setup(b) {
    b.onResolve({ filter: /^@ate\// }, (a) => {
      const m = /^(@ate\/[^/]+)(\/.*)?$/.exec(a.path);
      const dir = wsDirs[m[1]];
      if (!dir) return null;
      const exp = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).exports ?? {};
      const e = exp[m[2] ? `.${m[2]}` : "."];
      const target = typeof e === "string" ? e : (e?.import ?? "./dist/index.js");
      const src = join(dir, target.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts"));
      return { path: existsSync(src) ? src : join(dir, target) };
    });
    b.onLoad({ filter: /\.ts$/ }, (a) => {
      if (a.path.includes("node_modules")) return null;
      const r = rewrites.filter(([f]) => a.path.endsWith(f));
      let s = readFileSync(a.path, "utf8");
      const orig = s;
      for (const [, from, to] of r) {
        if (!s.includes(from)) throw new Error(`rewrite ${from} not found in ${a.path}`);
        s = s.replace(from, to);
      }
      // `const name = "@ate/x"; await import(name)` and `import("…" as string)` hide modules from the bundler
      s = s.replace(/import\(("[^"]+") as string\)/g, "import($1)");
      for (const m of [...s.matchAll(/const (\w+) = ("@ate\/[^"]+");/g)]) s = s.replaceAll(`import(${m[1]})`, `import(${m[2]})`);
      return s === orig ? null : { contents: s, loader: "ts" };
    });
  },
};
const bundle = (entry, outfile) =>
  esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    external: ["better-sqlite3", "bufferutil", "utf-8-validate"],
    plugins: [workspacePlugin],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: "warning",
  });

const sqliteSrc = dirname(realpathSync(join(repo, "apps/daemon/node_modules/better-sqlite3/package.json")));
const sqliteReq = createRequire(join(sqliteSrc, "package.json"));
const prebuild = join(dirname(realpathSync(sqliteReq.resolve("prebuild-install/package.json"))), "bin.js");

const backends = {};
for (const [platform, arch] of targets) {
  const be = join(work, `backend-${platform}-${arch}`);
  rmSync(be, { recursive: true, force: true });
  for (const [name, entry] of [["daemon", "apps/daemon/src/bin.ts"], ["owner", "apps/owner/src/bin.ts"]]) {
    await bundle(join(repo, entry), join(be, name, "bin.js"));
    writeFileSync(join(be, name, "package.json"), JSON.stringify({ type: "module", private: true }));
  }
  const d = join(be, "daemon");
  mkdirSync(join(d, "prompts"), { recursive: true });
  cpSync(join(repo, "agents/trader/PROMPT.md"), join(d, "prompts/trader.md"));
  cpSync(join(repo, "agents/chat/PROMPT.md"), join(d, "prompts/chat.md"));
  cpSync(join(repo, "packages/journal/migrations"), join(d, "migrations"), { recursive: true });
  // deployments/ and contracts are found by walking up from the bundle (and from cwd = backend)
  mkdirSync(join(be, "deployments"), { recursive: true });
  for (const f of readdirSync(join(repo, "deployments"))) if (/^\d+\.json$/.test(f)) cpSync(join(repo, "deployments", f), join(be, "deployments", f));
  for (const c of ["PolicyVault", "SupraAggregatorAdapter"]) {
    const f = join(repo, `contracts/out/${c}.sol/${c}.json`);
    if (existsSync(f)) cpSync(f, join(be, `contracts/out/${c}.sol/${c}.json`));
    else console.warn(`warn: ${f} missing (forge build contracts)`);
  }
  // better-sqlite3 (+ bindings, file-uri-to-path) with the Electron prebuild for this target
  const nm = join(d, "node_modules");
  const sq = join(nm, "better-sqlite3");
  cpSync(sqliteSrc, sq, { recursive: true, dereference: true, filter: (p) => !/better-sqlite3\/(deps|src|build|node_modules)(\/|$)/.test(p) });
  const bindings = dirname(realpathSync(sqliteReq.resolve("bindings/package.json")));
  cpSync(bindings, join(nm, "bindings"), { recursive: true, dereference: true });
  cpSync(dirname(realpathSync(createRequire(join(bindings, "package.json")).resolve("file-uri-to-path/package.json"))), join(nm, "file-uri-to-path"), { recursive: true, dereference: true });
  run(process.execPath, [prebuild, "--runtime", "electron", "--target", electronVersion, "--platform", platform, "--arch", arch, "--verbose"], sq);
  if (!existsSync(join(sq, "build/Release/better_sqlite3.node"))) throw new Error(`no better-sqlite3 prebuild for electron ${electronVersion} ${platform}-${arch}`);
  backends[platform] = be;
}

// ---- 4. electron-builder
const wantId = process.env.FLOW_MAC_IDENTITY ?? "Akash Jha (X9252GW4M3)";
const macIdentity = process.platform === "darwin" && wantId !== "-" && execFileSync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" }).includes(`Developer ID Application: ${wantId}`) ? wantId : null;
console.log(macIdentity ? `signing with Developer ID Application: ${macIdentity}` : "no Developer ID identity: ad-hoc signing");
mkdirSync(release, { recursive: true });
for (const [platform, arch] of targets) {
  const config = {
    appId: pkg.build.appId,
    productName: "Flow",
    electronVersion,
    npmRebuild: false,
    directories: { output: release, buildResources: join(desktop, "build") },
    files: ["out/**/*", "build/icon.png", "node_modules/**/*", "package.json"],
    extraResources: [{ from: backends[platform], to: "backend" }],
    artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
    ...(macIdentity ? {} : { afterPack: join(app, "afterpack.cjs") }),
    mac: {
      icon: join(desktop, "build/icon.icns"),
      category: "public.app-category.finance",
      target: ["dmg", "zip"],
      gatekeeperAssess: false,
      notarize: false,
      // Developer ID + hardened runtime when the identity is in the keychain, otherwise ad-hoc (afterpack.cjs)
      ...(macIdentity
        ? { identity: macIdentity, hardenedRuntime: true, entitlements: join(desktop, "scripts/entitlements.mac.plist"), entitlementsInherit: join(desktop, "scripts/entitlements.mac.plist") }
        : { identity: null, hardenedRuntime: false }),
    },
    dmg: { writeUpdateInfo: false },
    win: { icon: join(desktop, "build/icon.ico"), target: ["nsis", "zip"], signAndEditExecutable: false },
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, differentialPackage: false },
    publish: null,
  };
  const cfg = join(work, `builder-${platform}.json`);
  writeFileSync(cfg, JSON.stringify(config, null, 2));
  run("npx", ["-y", "electron-builder@25.1.8", "--projectDir", app, "--config", cfg, platform === "darwin" ? "--mac" : "--win", `--${arch}`], app);
}
console.log(`artifacts in ${release}`);
