// Invoke the `ate-approve` helper from Electron main, `ate chat` or the CLI (SPEC §10.1). The caller
// passes only the payload; the helper decodes it and builds the Touch ID prompt itself.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { encodePayload, type ApprovalPayload } from "./payload.js";

export const INSTALLED_HELPER_PATH = "/usr/local/libexec/ate/ate-approve";

export type ApproveErrorCode =
  | "invalid_payload"
  | "expired"
  | "unavailable"
  | "no_key"
  | "denied"
  | "keychain"
  | "internal"
  | "usage"
  | "not_installed"
  | "timeout";

export class ApproveError extends Error {
  override name = "ApproveError";
  constructor(
    readonly code: ApproveErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface SignedApproval {
  /** base64 DER ECDSA-P256-SHA256 signature over the canonical payload bytes. */
  signature: string;
  publicKey: string;
  keyId: string;
}

export interface HelperStatus {
  secureEnclave: boolean;
  biometrics: boolean;
  hasKey: boolean;
}

export interface ApproveClientOptions {
  /** Defaults to $ATE_APPROVE_PATH, then /usr/local/libexec/ate/ate-approve. */
  helperPath?: string;
  /** Touch ID prompt timeout; the daemon side expires nonces after 60 s anyway. */
  timeoutMs?: number;
}

function resolvePath(opts: ApproveClientOptions): string {
  return opts.helperPath ?? process.env.ATE_APPROVE_PATH ?? INSTALLED_HELPER_PATH;
}

function run(path: string, args: string[], timeoutMs: number): Promise<Record<string, unknown>> {
  if (!existsSync(path)) {
    return Promise.reject(new ApproveError("not_installed", `ate-approve not found at ${path}; degrade to the §10.1 TTY fallback`));
  }
  return new Promise((resolve, reject) => {
    execFile(path, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (err, stdout) => {
      const line = stdout.toString().trim().split("\n").pop() ?? "";
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        parsed = undefined;
      }
      if (err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
        reject(new ApproveError("timeout", "ate-approve timed out waiting for Touch ID"));
        return;
      }
      if (!parsed) {
        reject(new ApproveError("internal", `ate-approve produced no JSON (${err?.message ?? "no output"})`));
        return;
      }
      if (parsed.ok !== true) {
        const code = (typeof parsed.error === "string" ? parsed.error : "internal") as ApproveErrorCode;
        reject(new ApproveError(code, typeof parsed.message === "string" ? parsed.message : code));
        return;
      }
      resolve(parsed);
    });
  });
}

export function createApproveClient(opts: ApproveClientOptions = {}) {
  const path = resolvePath(opts);
  const timeoutMs = opts.timeoutMs ?? 90_000;
  return {
    path,
    async status(): Promise<HelperStatus> {
      const r = await run(path, ["status"], 10_000);
      return { secureEnclave: r.secureEnclave === true, biometrics: r.biometrics === true, hasKey: r.hasKey === true };
    },
    /** Creates the Secure Enclave key on first use; returns the public key to pin. */
    async publicKey(): Promise<{ publicKey: string; keyId: string; created: boolean }> {
      const r = await run(path, ["pubkey"], 30_000);
      return { publicKey: String(r.publicKey), keyId: String(r.keyId), created: r.created === true };
    },
    /** The prompt text the helper will show (no auth, no key). */
    async reason(payload: ApprovalPayload): Promise<string> {
      const r = await run(path, ["reason", encodePayload(payload)], 10_000);
      return String(r.reason);
    },
    /** Touch ID → Secure Enclave signature over the payload. */
    async sign(payload: ApprovalPayload): Promise<SignedApproval> {
      const r = await run(path, ["sign", encodePayload(payload)], timeoutMs);
      return { signature: String(r.signature), publicKey: String(r.publicKey), keyId: String(r.keyId) };
    },
  };
}
export type ApproveClient = ReturnType<typeof createApproveClient>;
