// ate-approve from Electron main (SPEC §10.1): Lane E's client. Main passes only the payload; the helper decodes it
// and builds the Touch ID prompt itself. Binary: $ATE_APPROVE_PATH, else /usr/local/libexec/ate/ate-approve.
import { ApproveError, createApproveClient, type ApprovalPayload } from "@ate/approve";

export type SignResult = { ok: true; signature: string } | { ok: false; unavailable: boolean; code: string; message: string };

/** Helper-side failures meaning "no Secure Enclave signature on this machine" (a TTY code may be used where allowed). */
const UNAVAILABLE = new Set(["not_installed", "unavailable", "no_key", "keychain", "internal", "usage"]);

export async function signApproval(payload: ApprovalPayload): Promise<SignResult> {
  try {
    const s = await createApproveClient({ timeoutMs: 70_000 }).sign(payload);
    return { ok: true, signature: s.signature };
  } catch (e) {
    const code = e instanceof ApproveError ? e.code : "internal";
    return { ok: false, unavailable: UNAVAILABLE.has(code), code, message: (e as Error).message };
  }
}
