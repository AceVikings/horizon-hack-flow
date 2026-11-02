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
  | "/setup/model/check"
  // lane D3's engine routes, reached from the Accounts page
  | "/engine/providers"
  | "/engine/select"
  | `/engine/providers/${string}/test`;
export type ApprovalPath = "/setup/config" | "/setup/model/key" | `/engine/providers/${string}/credential`;

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
  approveStart(path: ApprovalPath, body: unknown): Promise<Res<ApprovalStart>>;
  /** Step 2 with the one-time code. */
  approveFinish(path: ApprovalPath, nonce: string, code: string): Promise<Res<unknown>>;
  /** Open an allowlisted external link (explorer, faucet). */
  open(url: string): Promise<void>;
  /** Save a JSON file (deploy bundle) via the native save dialog. */
  saveJson(name: string, data: unknown): Promise<Res<{ path: string }>>;
  /**
   * Local proxy (advanced, user-run, never bundled): its management API, called from main with the management key.
   * op: "accounts" | "auth-url" (opens the provider's login page in the browser) | "status".
   */
  proxy(o: { baseURL: string; mgmtKey: string; op: "accounts" | "auth-url" | "status"; provider?: string; state?: string }): Promise<Res<unknown>>;
}

export const SETUP_IPC = ["setup.daemon", "setup.start", "setup.stop", "setup.submitCode", "setup.unlock", "setup.get", "setup.post", "setup.keygen", "setup.approveStart", "setup.approveFinish", "setup.open", "setup.saveJson", "setup.proxy"] as const;
export type SetupIpc = (typeof SETUP_IPC)[number];

const PROV = "(anthropic|openai|gemini|openrouter|ollama|proxy)";
export const SETUP_GET_RE = /^\/setup\/(status|networks|vaults|agent|doctor|limits|fund|handoff|config|model|model\/check)$|^\/engine\/providers$/;
export const SETUP_POST_RE = new RegExp(`^/setup/(state|network|vaults|handoff|complete|model|config)$|^/engine/select$|^/engine/providers/${PROV}/test$`);
export const APPROVAL_RE = new RegExp(`^/setup/(config|model/key)$|^/engine/providers/${PROV}/credential$`);
