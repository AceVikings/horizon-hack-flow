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
  | "/engine/proxy/install"
  | "/engine/opencode"
  | "/engine/opencode/test"
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
  /** One-time code for a pending loosening change (Touch ID not set up): null when none was issued. */
  /**
   * The user's own CLIProxyAPI (never bundled): detect the binary and its login flags (from its --help), pick it by
   * hand, open Terminal on one allowlisted login flag, or list the models its server reports at /v1/models.
   */
  proxyCli(o: { op: "detect" | "pick" | "login" | "models" | "opencode-login"; flag?: string; baseURL?: string; apiKey?: string }): Promise<Res<any>>;
  /** Touch ID for a risk-raising change (v1 policy). `{ method: "none" }` when Touch ID is not set up (ask in-app). */
  confirmRisk(reason: string): Promise<Res<{ method: "touch-id" | "none" }>>;
  strategyCode(changeId: string): Promise<{ code: string; expiresAt: number } | null>;
  proxy(o: { baseURL: string; mgmtKey: string; op: "accounts" | "auth-url" | "status"; provider?: string; state?: string }): Promise<Res<unknown>>;
}

export const SETUP_IPC = ["setup.daemon", "setup.start", "setup.stop", "setup.submitCode", "setup.unlock", "setup.get", "setup.post", "setup.keygen", "setup.approveStart", "setup.approveFinish", "setup.open", "setup.saveJson", "setup.proxy", "setup.strategyCode", "setup.proxyCli", "setup.confirmRisk"] as const;
export type SetupIpc = (typeof SETUP_IPC)[number];

const PROV = "(opencode|subscription|anthropic|openai|gemini|openrouter|ollama|proxy)";
export const SETUP_GET_RE = /^\/setup\/(status|networks|vaults|agent|doctor|limits|fund|handoff|config|model|model\/check)$|^\/engine\/providers$|^\/engine\/opencode$/;
export const SETUP_POST_RE = new RegExp(`^/setup/(state|network|vaults|handoff|complete|model|config)$|^/engine/select$|^/engine/proxy/install$|^/engine/opencode/test$|^/engine/providers/${PROV}/test$`);
export const APPROVAL_RE = new RegExp(`^/setup/(config|model/key)$|^/engine/providers/${PROV}/credential$`);

/**
 * Flow-managed owner signing (CLOUD lane; contract pending in FREEZE-NOTES "CLOUD"): an isolated owner service,
 * separate from the agent key, that deploys vaults and sends owner-only calls, so nothing is signed by hand.
 * Setup builds against this shape and falls back to plain instructions when `window.ate.owner` is absent.
 */
export interface OwnerTxs {
  txs: string[];
}
export interface OwnerJobStep {
  id: string;
  market: string;
  group: "deploy" | "limits" | "agent" | "seed";
  label: string;
  state: "waiting" | "sent" | "done" | "skipped" | "failed";
  hash?: string;
  sentAt?: number;
  doneAt?: number;
  error?: string;
}
export interface OwnerJob {
  id: string;
  markets: ("hsk" | "btc")[];
  startedAt: number;
  finishedAt?: number;
  state: "running" | "done" | "failed";
  steps: OwnerJobStep[];
  error?: string;
}
export interface OwnerVault {
  market: string | null;
  address: string;
  owner?: string;
  agent?: string;
  guardian?: string;
  paused?: boolean;
  /** Owner-service shape: USD caps × 1e8 as strings (maxTradeUsd, maxEpochUsd, maxExposureUsd), the rest numbers. */
  limits?: Record<string, string>;
  ownedByUs?: boolean;
  createdAt?: number | null;
  holdings?: { tokens: { symbol: string; address: string; decimals: number; raw: string }[]; priceE8: string | null };
  error?: string;
}
export interface OwnerState {
  chainId: number;
  owner: string;
  gasHsk: string | null;
  vaults: OwnerVault[];
  defaults: Record<string, string>;
  unfinished: { market: string; vault: string | null }[];
  job: OwnerJob | null;
  active: { market: string; address: string }[];
  explorer: string | null;
}
export interface OwnerBridge {
  /** Desktop and cloud also pass `gasHsk` (the owner wallet's HSK, decimal string) from GET /owner/state. */
  status(): Promise<Res<{ ready: boolean; address: string | null; chainId: number; gasHsk?: string | null }>>;
  /** `limits` in the daemon's /setup/limits shape (USD × 1e8 for the caps); `use: false` creates without switching. */
  createVaults(o?: { markets?: string[]; limits?: Record<string, string | number>; use?: boolean }): Promise<Res<OwnerTxs & { vaults: { market: string; address: string }[]; seconds?: number | null; seedError?: string | null }>>;
  /** Every vault the Flow wallet knows, active and earlier (desktop). */
  state?(): Promise<Res<OwnerState>>;
  /** One vault read from chain (desktop). */
  vault?(address: string): Promise<Res<OwnerVault>>;
  /** Live progress of the latest vault creation. */
  job?(): Promise<Res<OwnerJob | null>>;
  /** Switch a market's active vault; the daemon restarts on it. */
  useVault?(o: { market: string; address: string }): Promise<Res<{ restarted: boolean }>>;
  setAgent(agent: string): Promise<Res<OwnerTxs>>;
  /** `loosening` = risk-raising: the caller has already confirmed it with Touch ID (desktop) or a passkey (cloud). */
  setLimits(limits: unknown, o?: { markets?: string[]; loosening?: boolean; vaults?: string[] }): Promise<Res<OwnerTxs>>;
  unpause(market?: string): Promise<Res<OwnerTxs>>;
  /** Vault → `to` (default the owner wallet); `amount` in the token's smallest unit. Risk-raising: Touch ID. */
  withdraw?(o: { vault: string; token: string; amount: string; to?: string }): Promise<Res<OwnerTxs>>;
  /** Owner wallet → agent key, `wei` of HSK for gas. Risk-raising: Touch ID. */
  fundAgent?(wei: string): Promise<Res<OwnerTxs>>;
  /** Backup: after Touch ID, the owner key once. Absent or erroring when the key lives in a KMS. */
  exportKey?(): Promise<Res<{ address: string; privateKey: string }>>;
}
