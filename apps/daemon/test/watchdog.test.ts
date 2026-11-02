import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { pidAlive, watchParent } from "../src/watchdog.js";

describe("parent watchdog", () => {
  it("fires once when the parent disappears", async () => {
    let up = true;
    let n = 0;
    const stop = watchParent(4242, () => n++, { intervalMs: 10, alive: () => up, ppid: () => 4242 });
    await new Promise((r) => setTimeout(r, 40));
    expect(n).toBe(0);
    up = false;
    await new Promise((r) => setTimeout(r, 40));
    expect(n).toBe(1);
    stop();
  });
  it("fires when re-parented (parent died, child adopted by launchd/init)", async () => {
    let n = 0;
    watchParent(4242, () => n++, { intervalMs: 10, alive: () => true, ppid: () => 1 });
    await new Promise((r) => setTimeout(r, 40));
    expect(n).toBe(1);
  });
  it("a real child exits after its parent is killed", async () => {
    // parent: a node process that spawns a child running the watchdog against the parent's pid, prints the child pid
    const code = `
      const { spawn } = require("node:child_process");
      const c = spawn(process.execPath, ["-e", ${JSON.stringify(`
        const alive = (p) => { try { process.kill(p, 0); return true } catch { return false } };
        const parent = Number(process.env.P);
        setInterval(() => { if (!alive(parent) || process.ppid !== parent) process.exit(0) }, 50);
      `)}], { env: { ...process.env, P: String(process.pid) }, stdio: "ignore" });
      console.log(c.pid);
      setInterval(() => {}, 1000);
    `;
    const parent = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "ignore"] });
    const childPid = await new Promise<number>((r) => parent.stdout!.once("data", (b) => r(Number(String(b).trim()))));
    expect(pidAlive(childPid)).toBe(true);
    parent.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 600));
    expect(pidAlive(childPid)).toBe(false);
  });
});
