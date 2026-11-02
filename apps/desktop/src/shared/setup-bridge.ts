// Setup + daemon-lifecycle bridge (lane D2): `window.ate.setup`. Main owns the daemon process, the ui token, the
// sealed agent-key passphrase and every approval; the renderer only sees setup data, never a secret except the
// one-time code it is asked to show (when Touch ID is unavailable) and a private key the user pastes to import.
import type { Res } from "./bridge";

export type DaemonPhase = "starting" | "attaching" | "code" | "unlocking" | "ready" | "stopped" | "error";

export interface DaemonState {
  phase: DaemonPhase;
  /** We spawned it (lifecycle is ours) vs attached to one already running. */
  owned: boolean;
  home: string;
  pid: number | null;
  port: number | null;
  detail: string;
  /** Touch ID paths available on this Mac. */
  touchId: { approve: boolean; unlock: boolean };
  /** When phase = "code": the daemon's one-time approval code (Touch ID unavailable), and what it approves. */
  code: { code: string | null; purpose: string; expiresAt: number } | null;
  /** Agent key status from the daemon. */
  agent: { exists: boolean; unlocked: boolean; address: string | null; sealed: boolean } | null;
  /** Setup progress (resume step) once attached. */
  setupStep: number | null;
  setupDone: boolean;
}

/** GET/POST passthrough to the daemon's /setup/* routes (allowlisted in main). */
export type SetupPath =
  | "/setup/status"
  | "/setup/state"
  | "/setup/networks"
  | "/setup/network"
  | "/setup/vaults"
  | "/setup/agent"
  | "/setup/doctor"
  | "/setup/limits"
  | "/setup/fund"
  | "/setup/handoff"
  | "/setup/complete"
  | "/setup/config"
  | "/setup/model"
  | "/setup/model/check";

/** Two-step approvals (Settings save, API key replace/remove): Touch ID via ate-approve, else a one-time code. */
export interface ApprovalStart {
  nonce: string;
  expiresAt: number;
  /** Touch ID was used and the change is already applied. */
  applied?: boolean;
  /** Touch ID unavailable: the code to show and type back. */
  code?: string | null;
  result?: unknown;
}

export interface SetupBridge {
  daemon(): Promise<DaemonState>;
  /** Start (or restart) the daemon this app owns. */
  start(): Promise<DaemonState>;
  stop(): Promise<DaemonState>;
  /** Submit the one-time code shown for /ui/attach. */
  submitCode(code: string): Promise<Res<DaemonState>>;
  /** Unlock the agent key (Touch ID when available). */
  unlock(): Promise<Res<DaemonState>>;
  get<T = unknown>(path: SetupPath, query?: Record<string, string>): Promise<Res<T>>;
  post<T = unknown>(path: SetupPath, body?: unknown): Promise<Res<T & { restart?: boolean }>>;
  /** Create (privateKey omitted) or import the agent key; main generates + seals the passphrase (Touch ID). */
  keygen(privateKey?: string): Promise<Res<{ address: string; store: string; keyId: string }>>;
  /** Settings save / API-key change: step 1 (main tries Touch ID first). */
  approveStart(path: "/setup/config" | "/setup/model/key", body: unknown): Promise<Res<ApprovalStart>>;
  /** Step 2 with the one-time code. */
  approveFinish(path: "/setup/config" | "/setup/model/key", nonce: string, code: string): Promise<Res<unknown>>;
  /** Open an allowlisted external link (explorer, faucet). */
  open(url: string): Promise<void>;
  /** Save a JSON file (deploy bundle) via the native save dialog. */
  saveJson(name: string, data: unknown): Promise<Res<{ path: string }>>;
}

export const SETUP_IPC = ["setup.daemon", "setup.start", "setup.stop", "setup.submitCode", "setup.unlock", "setup.get", "setup.post", "setup.keygen", "setup.approveStart", "setup.approveFinish", "setup.open", "setup.saveJson"] as const;
export type SetupIpc = (typeof SETUP_IPC)[number];

export const SETUP_GET: readonly SetupPath[] = ["/setup/status", "/setup/networks", "/setup/vaults", "/setup/agent", "/setup/doctor", "/setup/limits", "/setup/fund", "/setup/handoff", "/setup/config", "/setup/model", "/setup/model/check"] as unknown as SetupPath[];
export const SETUP_POST: readonly SetupPath[] = ["/setup/state", "/setup/network", "/setup/vaults", "/setup/handoff", "/setup/complete", "/setup/model"];
