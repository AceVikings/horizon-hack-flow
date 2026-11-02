// Approval tickets: a bridge call that needs the user's passkey pauses mid-flight. The HTTP response carries a ticket
// (challenge + what is being approved); the browser runs navigator.credentials.get and posts the assertion to
// /api/approve, which resumes the same call (so daemon nonces issued in step 1 stay valid) and answers with its
// result, or with the next ticket.
import { randomBytes } from "node:crypto";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

export interface PasskeyAsk {
  challenge: string;
  prompt: string;
}

export interface RunCtx {
  /** Ask the browser for a passkey assertion over `challenge`. Rejects when the user cancels or after 120 s. */
  passkey(a: PasskeyAsk): Promise<AuthenticationResponseJSON>;
}

type Outcome = { kind: "result"; value: unknown } | { kind: "ticket"; ticket: string; ask: PasskeyAsk };

interface Run {
  sessionId: string;
  next: () => Promise<Outcome>;
  answer?: (a: AuthenticationResponseJSON | null) => void;
  at: number;
}

export class Runs {
  private byTicket = new Map<string, Run>();

  /** Start `fn`; resolves with its result or the first ticket. */
  start(sessionId: string, fn: (ctx: RunCtx) => Promise<unknown>): Promise<Outcome> {
    let wake: ((o: Outcome) => void) | null = null;
    const queue: Outcome[] = [];
    const push = (o: Outcome) => (wake ? (wake(o), (wake = null)) : queue.push(o));
    const run: Run = {
      sessionId,
      at: Date.now(),
      next: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise<Outcome>((r) => (wake = r))),
    };
    const ctx: RunCtx = {
      passkey: (ask) =>
        new Promise((resolve, reject) => {
          const ticket = randomBytes(18).toString("base64url");
          const timer = setTimeout(() => {
            this.byTicket.delete(ticket);
            reject(Object.assign(new Error("the passkey approval timed out"), { code: "ATE_APPROVAL_REQUIRED" }));
          }, 120_000);
          run.answer = (a) => {
            clearTimeout(timer);
            this.byTicket.delete(ticket);
            if (a) resolve(a);
            else reject(Object.assign(new Error("the passkey approval was cancelled"), { code: "ATE_APPROVAL_REQUIRED" }));
          };
          this.byTicket.set(ticket, run);
          push({ kind: "ticket", ticket, ask });
        }),
    };
    fn(ctx).then(
      (value) => push({ kind: "result", value }),
      (e: Error & { code?: string }) => push({ kind: "result", value: { ok: false, error: { code: e.code ?? "ATE_INTERNAL", message: e.message } } }),
    );
    return run.next();
  }

  /** Resume the run waiting on `ticket` with the assertion (null = cancel). */
  resume(sessionId: string, ticket: string, a: AuthenticationResponseJSON | null): Promise<Outcome> | null {
    const run = this.byTicket.get(ticket);
    if (!run || run.sessionId !== sessionId || !run.answer) return null;
    const answer = run.answer;
    run.answer = undefined;
    answer(a);
    return run.next();
  }
}
