// Setup wizard route `#/setup/<1..3>` (SIMPLIFY.md: Connect → Set limits → Start). Each step persists progress in the daemon's
// setup.json, so the app resumes where the user left off.
import { lazy, Suspense } from "react";
import type { ViewProps } from "../registry";
import { Spinner } from "./common";

const STEP = [lazy(() => import("./StepConnect")), lazy(() => import("./StepLimits")), lazy(() => import("./StepStart"))];

export default function Wizard({ params }: ViewProps) {
  const n = Math.min(3, Math.max(1, Number(params[0] ?? 1) || 1));
  const S = STEP[n - 1]!;
  return (
    <Suspense fallback={<div style={{ padding: 40 }}><Spinner label="Loading…" /></div>}>
      <S />
    </Suspense>
  );
}
