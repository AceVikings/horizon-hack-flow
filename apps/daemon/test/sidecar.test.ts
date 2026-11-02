// CLIProxyAPI sidecar with a mocked release and a fake proxy binary: install verifies the checksum, start binds
// 127.0.0.1 with generated keys (no cloaking config), health via /v1/models, the engine picks the best subscription
// model and talks to the proxy (OpenAI-compatible for GPT, Claude-compatible for Claude).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AiEngine } from "../src/engine.js";
import { ProviderKeys } from "../src/providers.js";
import { ProxySidecar, assetSuffix, bestModel, configYaml } from "../src/sidecar.js";

const FAKE = `#!/usr/bin/env node
// fake CLIProxyAPI: reads port + client key from the config Flow wrote, serves /v1/models and a chat completion
const fs = require("fs"), http = require("http");
if (process.argv.includes("--help")) { console.error("Usage:\\n  -config string\\n  -login\\n  -claude-login\\n  -codex-login"); process.exit(2); }
const cfg = fs.readFileSync(process.argv[process.argv.indexOf("-config") + 1], "utf8");
const port = Number(/port: (\\d+)/.exec(cfg)[1]);
const key = /- "([^"]+)"/.exec(cfg)[1];
http.createServer((req, res) => {
  if (req.headers.authorization !== "Bearer " + key) { res.writeHead(401); return res.end("{}"); }
  if (req.url === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "gpt-5" }, { id: "gpt-5-mini" }, { id: "claude-sonnet-4-5" }, { id: "claude-opus-4-1" }] })); }
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: " + JSON.stringify({ model: JSON.parse(b).model, choices: [{ delta: { content: "hello from your subscription" }, finish_reason: "stop" }] }) + "\\n\\n");
    res.end("data: [DONE]\\n\\n");
  });
}).listen(port, "127.0.0.1");
`;

const homes: ProxySidecar[] = [];
afterAll(async () => {
  for (const s of homes) await s.stop();
});

describe("sidecar config + release", () => {
  it("asset names follow the release naming; config is loopback-only with no cloaking keys", () => {
    expect(assetSuffix("darwin", "arm64")).toBe("_darwin_aarch64.tar.gz");
    expect(assetSuffix("linux", "x64")).toBe("_linux_amd64.tar.gz");
    const y = configYaml({ port: 8317, apiKey: "k1", mgmtKey: "m1" });
    expect(y).toContain('host: "127.0.0.1"');
    expect(y).toContain("allow-remote: false");
    expect(y).not.toMatch(/cloak/i);
    expect(configYaml({ port: 1, apiKey: "a", mgmtKey: "b", authDir: "/x/auths" })).toContain('auth-dir: "/x/auths"');
  });

  it("installs only a checksum-verified release", async () => {
    const work = mkdtempSync(join(tmpdir(), "flow-rel-"));
    mkdirSync(join(work, "pkg"));
    writeFileSync(join(work, "pkg", "cli-proxy-api"), FAKE);
    execFileSync("/usr/bin/tar", ["-czf", join(work, "a.tar.gz"), "-C", join(work, "pkg"), "cli-proxy-api"]);
    const tgz = readFileSync(join(work, "a.tar.gz"));
    const name = `CLIProxyAPI_9.9.9${assetSuffix()}`;
    const mk = (sum: string) => (async (u: string) => {
      const url = String(u);
      if (url.includes("releases/latest")) return new Response(JSON.stringify({ tag_name: "v9.9.9", assets: [{ name, browser_download_url: "https://x/a" }, { name: "checksums.txt", browser_download_url: "https://x/sums" }] }));
      if (url.endsWith("/sums")) return new Response(`${sum}  ${name}\n`);
      return new Response(tgz);
    }) as typeof fetch;
    const env = { ATE_KEYSTORE: "file", PATH: "" };
    const bad = new ProxySidecar(mkdtempSync(join(tmpdir(), "flow-h-")), new ProviderKeys("/tmp", env), env, mk("0".repeat(64)));
    await expect(bad.install()).rejects.toThrow(/checksum mismatch/);
    expect(bad.status().installed).toBe(false);
    const home = mkdtempSync(join(tmpdir(), "flow-h-"));
    const good = new ProxySidecar(home, new ProviderKeys(home, env), env, mk(createHash("sha256").update(tgz).digest("hex")));
    const st = await good.install();
    expect(st).toMatchObject({ installed: true, source: "flow", version: "9.9.9" });
    expect(st.bin).toContain(join(home, "bin", "cliproxyapi-9.9.9"));
  });
});

describe("sidecar lifecycle + subscription engine", () => {
  it("starts the proxy on 127.0.0.1 with generated keys, picks the best model and chats through it", async () => {
    const home = mkdtempSync(join(tmpdir(), "flow-h-"));
    const bin = join(home, "fake-cli-proxy-api");
    writeFileSync(bin, FAKE);
    chmodSync(bin, 0o755);
    const env = { ATE_KEYSTORE: "file", ATE_CLIPROXY_BIN: bin, PATH: process.env.PATH ?? "" };
    const keys = new ProviderKeys(home, env);
    const sc = new ProxySidecar(home, keys, env);
    homes.push(sc);
    expect(sc.loginFlags()).toEqual(["-login", "-claude-login", "-codex-login"]);
    const st = await sc.start();
    expect(st).toMatchObject({ running: true, healthy: true });
    expect(st.models).toContain("gpt-5");
    const cfg = readFileSync(join(home, "cliproxy", "config.yaml"), "utf8");
    expect(cfg).toContain(keys.load("subscription")!);
    expect(cfg).toContain(keys.load("subscription-mgmt")!);

    const ai = new AiEngine(home, env, {}, sc);
    expect(ai.config.provider).toBe("subscription");
    await ai.test("subscription");
    expect(ai.available()).toBe(true);
    expect(ai.effectiveModel()).toBe("claude-opus-4-1"); // Claude: opus before sonnet before GPT
    expect(ai.conversation().protocol).toBe("anthropic");
    ai.setConfig({ provider: "subscription", model: "gpt-5" });
    const c = ai.conversation();
    expect(c).toMatchObject({ protocol: "openai", model: "gpt-5" });
    ai.pushUser(c, "hi");
    const r = await ai.run("chat", c, { effort: "low", system: "s", toolNames: ["ate_positions"], call: async () => ({ content: "{}", isError: false }) });
    expect(r).toMatchObject({ text: "hello from your subscription", stop: "end_turn" });
    expect((await sc.stop()).running).toBe(false);
  }, 20_000);

  it("best model: Claude opus → sonnet, then the GPT-5 family, newest first", () => {
    expect(bestModel(["gpt-5", "claude-sonnet-4-5", "claude-opus-4-1", "claude-opus-4-5"])).toBe("claude-opus-4-5");
    expect(bestModel(["gpt-5-mini", "gpt-5", "gemini-2.5-pro"])).toBe("gpt-5");
    expect(bestModel(["gpt-5-codex", "gpt-5.1-codex", "gpt-5-mini"])).toBe("gpt-5.1-codex");
    expect(bestModel([])).toBeNull();
  });
});
