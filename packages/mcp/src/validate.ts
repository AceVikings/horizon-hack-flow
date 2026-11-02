// Input validation against the frozen JSON Schemas (Ajv, draft-07 compatible).

import AjvModule from "ajv";
import type { ToolName } from "@ate/core";
import { TOOL_DEFINITIONS } from "./schemas.js";

// ajv ships CJS; under NodeNext the default import is the module namespace in some toolchains.
type AjvCtor = typeof AjvModule.default;
const Ajv = ((AjvModule as unknown as { default?: AjvCtor }).default ?? AjvModule) as AjvCtor;

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
const validators = new Map(
  Object.values(TOOL_DEFINITIONS).map((t) => [t.name, ajv.compile(t.inputSchema)] as const),
);

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Validates (and applies schema defaults to) `args` in place. */
export function validateToolInput(name: ToolName, args: unknown): ValidationResult {
  const v = validators.get(name);
  if (!v) return { ok: false, errors: [`unknown tool ${name}`] };
  const ok = v(args) as boolean;
  return { ok, errors: ok ? [] : (v.errors ?? []).map((e: { instancePath: string; message?: string }) => `${e.instancePath || "<root>"} ${e.message ?? "invalid"}`) };
}
