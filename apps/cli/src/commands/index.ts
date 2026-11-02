// `ate` command registry (SPEC §3.3, §21.4). FROZEN at the interface freeze.
//
// Each lane owns exactly one directory and nothing else in apps/cli:
//   src/commands/a/  rogue                                              (Lane A)
//   src/commands/b/  doctor, unlock, smoke                              (Lane B)
//   src/commands/c/  init, daemon, mcp, agent, chat, journal, replay, ui (Lane C)
// Every `*.ts` file in a lane directory (except `_*.ts`, `*.test.ts`, `*.d.ts`) is loaded at startup
// and must `export default` a CommandModule. Adding a command = adding a file; never edit this file.

import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

export const LANES = ["a", "b", "c"] as const;
export type Lane = (typeof LANES)[number];

/** Top-level command names reserved per lane (§3.3). A lane may add other names; it may not take another lane's. */
export const LANE_COMMANDS: Readonly<Record<Lane, readonly string[]>> = {
  a: ["rogue"],
  b: ["doctor", "unlock", "smoke"],
  c: ["init", "daemon", "mcp", "agent", "chat", "journal", "replay", "ui"],
};

export const BUILTIN_COMMANDS = ["help", "version"] as const;

export interface CommandContext {
  /** Arguments after the command name (subcommands and flags are parsed by the command). */
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export interface CommandModule {
  /** Top-level name: `ate <name> …`. Lowercase, [a-z][a-z0-9-]*. */
  name: string;
  /** One line for `ate help`. */
  summary: string;
  /** Optional multi-line usage for `ate help <name>`. */
  usage?: string;
  /** Exit code (default 0). Throw an AteError for failures; the runner prints message + hint. */
  run(ctx: CommandContext): Promise<number | void> | number | void;
}

export interface LoadedCommand extends CommandModule {
  lane: Lane;
  file: string;
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const FILE_RE = /^(?!_)(?!.*\.test\.)(?!.*\.d\.ts$).+\.(ts|js|mjs)$/;

function isCommandModule(x: unknown): x is CommandModule {
  const c = x as CommandModule;
  return !!c && typeof c.name === "string" && typeof c.summary === "string" && typeof c.run === "function";
}

/** Loads every lane directory under `baseDir` (default: this file's directory). */
export async function loadCommands(baseDir: string = fileURLToPath(new URL(".", import.meta.url))): Promise<Map<string, LoadedCommand>> {
  const out = new Map<string, LoadedCommand>();
  const owner = new Map<string, Lane>();
  for (const lane of LANES) for (const n of LANE_COMMANDS[lane]) owner.set(n, lane);

  for (const lane of LANES) {
    const dir = join(baseDir, lane);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f) => FILE_RE.test(f)).sort();
    for (const f of files) {
      const file = join(dir, f);
      const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
      const cmd = mod.default;
      if (!isCommandModule(cmd)) throw new Error(`${file}: default export is not a CommandModule {name, summary, run}`);
      if (!NAME_RE.test(cmd.name)) throw new Error(`${file}: invalid command name "${cmd.name}"`);
      if ((BUILTIN_COMMANDS as readonly string[]).includes(cmd.name)) throw new Error(`${file}: "${cmd.name}" is a built-in`);
      const reservedBy = owner.get(cmd.name);
      if (reservedBy && reservedBy !== lane) throw new Error(`${file}: "${cmd.name}" is reserved for lane ${reservedBy}`);
      const prev = out.get(cmd.name);
      if (prev) throw new Error(`duplicate command "${cmd.name}": ${prev.file} and ${file}`);
      out.set(cmd.name, { ...cmd, lane, file });
    }
  }
  return out;
}

export const CLI_VERSION = "0.1.0";

function helpText(cmds: Map<string, LoadedCommand>): string {
  const lines = ["Usage: ate <command> [args]", "", "Commands:"];
  const all = [...cmds.values()].sort((a, b) => a.name.localeCompare(b.name));
  const w = Math.max(8, ...all.map((c) => c.name.length));
  for (const c of all) lines.push(`  ${c.name.padEnd(w)}  ${c.summary}`);
  lines.push(`  ${"help".padEnd(w)}  Show help (ate help <command>)`, `  ${"version".padEnd(w)}  Print the CLI version`);
  return lines.join("\n") + "\n";
}

/** Entry point used by bin.ts and tests. Returns the process exit code. */
export async function runCli(argv: string[], io: Partial<CommandContext> = {}, baseDir?: string): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cmds = await loadCommands(baseDir);
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    const target = rest[0] ? cmds.get(rest[0]) : undefined;
    stdout.write(target ? `${target.name} — ${target.summary}\n${target.usage ?? ""}\n` : helpText(cmds));
    return 0;
  }
  if (name === "version" || name === "--version") {
    stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }
  const cmd = cmds.get(name);
  if (!cmd) {
    stderr.write(`ate: unknown command "${name}"\n${helpText(cmds)}`);
    return 2;
  }
  try {
    const code = await cmd.run({ argv: rest, env: io.env ?? process.env, cwd: io.cwd ?? process.cwd(), stdout, stderr });
    return typeof code === "number" ? code : 0;
  } catch (e) {
    const err = e as { message?: string; hint?: string; code?: string };
    stderr.write(`ate ${name}: ${err.code ? `[${err.code}] ` : ""}${err.message ?? String(e)}\n${err.hint ? `hint: ${err.hint}\n` : ""}`);
    return 1;
  }
}
