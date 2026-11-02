import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { LANE_COMMANDS, loadCommands, runCli } from "../src/commands/index.js";

function sink() {
  let buf = "";
  const s = new Writable({ write(c, _e, cb) { buf += c.toString(); cb(); } });
  return { s, text: () => buf };
}

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ate-cli-"));
  for (const [rel, src] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), src);
  }
  return dir;
}

const cmd = (name: string, out = name) => `export default { name: "${name}", summary: "${name} summary", run(ctx) { ctx.stdout.write("${out}:" + ctx.argv.join(",")); return 0; } };\n`;

describe("command registry", () => {
  it("loads the real lane directories; every reserved name is served by its own lane", async () => {
    // Was "(empty)" at the freeze; lanes now add one file per command (Lane C edit: ownership check instead).
    const cmds = await loadCommands();
    for (const c of cmds.values()) {
      const owner = (Object.entries(LANE_COMMANDS) as [string, readonly string[]][]).find(([, names]) => names.includes(c.name))?.[0];
      if (owner) expect(c.lane).toBe(owner);
    }
  }, 30_000);

  it("loads per-lane files, skips _private and tests, dispatches argv", async () => {
    const dir = fixture({
      "a/rogue.mjs": cmd("rogue"),
      "b/doctor.mjs": cmd("doctor"),
      "b/_helpers.mjs": "export const x = 1;\n",
      "c/mcp.mjs": cmd("mcp"),
      "c/mcp.test.mjs": "throw new Error('must not load');\n",
    });
    const cmds = await loadCommands(dir);
    expect([...cmds.values()].map((c) => `${c.lane}/${c.name}`).sort()).toEqual(["a/rogue", "b/doctor", "c/mcp"]);
    const out = sink();
    expect(await runCli(["mcp", "serve", "--stdio"], { stdout: out.s }, dir)).toBe(0);
    expect(out.text()).toBe("mcp:serve,--stdio");
  });

  it("rejects another lane's reserved name and duplicates", async () => {
    await expect(loadCommands(fixture({ "c/doctor.mjs": cmd("doctor") }))).rejects.toThrow(/reserved for lane b/);
    await expect(loadCommands(fixture({ "b/x.mjs": cmd("extra"), "c/y.mjs": cmd("extra") }))).rejects.toThrow(/duplicate/);
  });

  it("help, version and unknown command", async () => {
    const dir = fixture({ "b/doctor.mjs": cmd("doctor") });
    const out = sink();
    expect(await runCli([], { stdout: out.s }, dir)).toBe(0);
    expect(out.text()).toContain("doctor");
    const err = sink();
    expect(await runCli(["nope"], { stderr: err.s }, dir)).toBe(2);
  });
});
