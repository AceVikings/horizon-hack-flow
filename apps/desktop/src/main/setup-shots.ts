// Screenshot automation for the setup flow (FLOW_SETUP_SHOTS=<dir>): waits on each screen the wizard reaches and
// captures it as setup-<n>-<name>.png. Driven by the same buttons a person clicks; reads no secrets.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BrowserWindow } from "electron";

export async function runSetupShots(win: () => BrowserWindow | null, dir: string): Promise<void> {
  const out = resolve(dir);
  mkdirSync(out, { recursive: true });
  const seen = new Set<string>();
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  win()?.setSize(1440, 900);
  for (let i = 0; i < 2400; i++) {
    await wait(500);
    const w = win();
    if (!w) return;
    const shot = (await w.webContents.executeJavaScript(`document.querySelector("[data-shot]")?.getAttribute("data-shot") ?? ""`).catch(() => "")) as string;
    if (!shot || seen.has(shot)) continue;
    await wait(Number(process.env.FLOW_SHOT_SETTLE_MS ?? 2500));
    const again = (await w.webContents.executeJavaScript(`document.querySelector("[data-shot]")?.getAttribute("data-shot") ?? ""`).catch(() => "")) as string;
    if (again !== shot) continue;
    seen.add(shot);
    writeFileSync(join(out, `setup-${shot}.png`), (await w.webContents.capturePage()).toPNG());
  }
}
