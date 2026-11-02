// Chart fetching hook shared by Charts, Trade and Tools.
import { useEffect, useState } from "react";
import type { ChartInput, ChartSpec } from "@ate/core";
import type { Res } from "@shared/bridge";
import { useApp } from "../app";
import { loadWithTimeout } from "./load";

/**
 * Fetches a chart for `input`; refetches on change, every `every` ms and on `retry()`. Every request ends within
 * 15 s (timeout, rejected IPC and errors become `error`), so a chart is never left loading. Keeps the last good spec.
 */
export function useChart(input: ChartInput, every = 60_000): { spec: ChartSpec | null; error: string | null; busy: boolean; retry(): void } {
  const { ate } = useApp();
  const key = JSON.stringify(input);
  const [spec, setSpec] = useState<ChartSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () => {
      const charts = ate.charts;
      if (!charts) {
        setError("Charts need the Flow service. Restart Flow to load them.");
        setBusy(false);
        return;
      }
      setBusy(true);
      void loadWithTimeout(() => charts.chart(JSON.parse(key) as ChartInput)).then((r: Res<ChartSpec>) => {
        if (!live) return;
        setBusy(false);
        if (r.ok) {
          setSpec(r.data);
          setError(null);
        } else setError(r.error.message);
      });
    };
    load();
    const i = setInterval(load, every);
    return () => {
      live = false;
      clearInterval(i);
    };
  }, [ate, key, every, n]);
  return { spec, error, busy, retry: () => setN((x) => x + 1) };
}

