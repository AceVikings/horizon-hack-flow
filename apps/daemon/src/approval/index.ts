// apps/daemon/src/approval — Lane E's mount point inside Lane B's daemon (SPEC §3.3, §10.1).
//
// Lane B: add `"@ate/approve": "workspace:*"` to apps/daemon/package.json, then at startup:
//
//   const approval = createDaemonApproval({ pid: process.pid, port, approvalFallback: config.daemon.approvalFallback,
//     mintUiToken, mintSessionToken, getPendingStrategyChange, applyStrategyChange, journalApproval });
//   // HTTP: either mount approval.routes in your router (each has { method, path, scopes, auth, handle(body, scope) }),
//   // or call `if (await approval.nodeHandler(req, res)) return;` first in a plain node:http server.
//   // TTY: process.stdin lines → approval.tty.handleTtyLine(line)  (no HTTP route for `approval-fallback enable`)
//   // ate_strategy_set → ATE_APPROVAL_REQUIRED: also call approval.service.onStrategyPending(details)
//
// The logic and its tests live in apps/approve/src/daemon (package @ate/approve/daemon).
import { createWriteStream, existsSync, openSync } from "node:fs";
import type { TokenScope } from "@ate/core";
import { createApprovalVerifier, DEFAULT_PINNED_KEY_PATH, loadPinnedKey } from "@ate/approve";
import {
  ApprovalService,
  TtyFallback,
  approvalRoutes,
  createNodeApprovalHandler,
  type ApprovalServiceDeps,
  type FallbackMode,
} from "@ate/approve/daemon";

export interface DaemonApprovalOptions extends Omit<ApprovalServiceDeps, "verifier" | "tty"> {
  approvalFallback: FallbackMode;
  /** Defaults to ~/.ate/approve-pubkey.json; missing file → signatures unavailable (TTY fallback only). */
  pinnedKeyPath?: string;
  /** Defaults to writing /dev/tty (the controlling terminal) — never a log file or /events. */
  ttyWrite?: (line: string) => void;
  /** Bearer → scope, for nodeHandler. */
  resolveScope?: (authorization: string | undefined) => TokenScope | null;
}

function controllingTtyWriter(): (line: string) => void {
  try {
    const fd = openSync("/dev/tty", "w");
    const s = createWriteStream("", { fd });
    return (line) => s.write(`${line}\n`);
  } catch {
    // Headless with no controlling TTY: codes cannot be delivered, so they are never printed anywhere.
    return () => {};
  }
}

export function createDaemonApproval(opts: DaemonApprovalOptions) {
  const keyPath = opts.pinnedKeyPath ?? DEFAULT_PINNED_KEY_PATH;
  const verifier = existsSync(keyPath) ? createApprovalVerifier(loadPinnedKey(keyPath), "ate-daemon") : null;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const tty = new TtyFallback({ mode: opts.approvalFallback, ttyWrite: opts.ttyWrite ?? controllingTtyWriter(), now });
  const service = new ApprovalService({ ...opts, verifier, tty, now });
  return {
    service,
    tty,
    routes: approvalRoutes(service),
    nodeHandler: createNodeApprovalHandler(service, opts.resolveScope ?? (() => null)),
    hasPinnedKey: verifier !== null,
  };
}
export type DaemonApproval = ReturnType<typeof createDaemonApproval>;
