// §9.6: session tokens, JWTs and signatures are never logged; the journal stores digests only.
const SECRET_KEYS = /^(signature|jwt|token|authorization|session|secret|private_?key|bearer|approval)$/i;
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const SIG_RE = /0x[0-9a-fA-F]{130}\b/g;

export function redact<T>(v: T): T {
  if (typeof v === "string") return v.replace(JWT_RE, "[jwt]").replace(SIG_RE, "[sig]") as T;
  if (Array.isArray(v)) return v.map(redact) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const isAddress = typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x);
      out[k] = SECRET_KEYS.test(k) && !isAddress ? "[redacted]" : redact(x);
    }
    return out as T;
  }
  return v;
}
