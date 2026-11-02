// Pinned charts (Charts workspace): stored locally per user as chart inputs, so each pin re-fetches fresh data.
import { useCallback, useEffect, useState } from "react";
import type { ChartInput } from "@ate/core";

export interface Pin {
  id: string;
  input: ChartInput;
  addedAt: number;
}
const KEY = "flow.charts.pins.v1";
const EVT = "flow:pins";

export function readPins(): Pin[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as Pin[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function write(p: Pin[]) {
  localStorage.setItem(KEY, JSON.stringify(p));
  window.dispatchEvent(new Event(EVT));
}

/** Adds a pin (deduped by input) and returns its id. */
export function addPin(input: ChartInput): string {
  const ps = readPins();
  const same = ps.find((p) => JSON.stringify(p.input) === JSON.stringify(input));
  if (same) return same.id;
  const id = `pin_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  write([...ps, { id, input, addedAt: Math.floor(Date.now() / 1000) }]);
  return id;
}

export function usePins(): { pins: Pin[]; remove(id: string): void; update(id: string, input: ChartInput): void; move(id: string, dir: -1 | 1): void } {
  const [pins, setPins] = useState<Pin[]>(readPins);
  useEffect(() => {
    const on = () => setPins(readPins());
    window.addEventListener(EVT, on);
    window.addEventListener("storage", on);
    return () => {
      window.removeEventListener(EVT, on);
      window.removeEventListener("storage", on);
    };
  }, []);
  const remove = useCallback((id: string) => write(readPins().filter((p) => p.id !== id)), []);
  const update = useCallback((id: string, input: ChartInput) => write(readPins().map((p) => (p.id === id ? { ...p, input } : p))), []);
  const move = useCallback((id: string, dir: -1 | 1) => {
    const ps = readPins();
    const i = ps.findIndex((p) => p.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ps.length) return;
    [ps[i], ps[j]] = [ps[j]!, ps[i]!];
    write(ps);
  }, []);
  return { pins, remove, update, move };
}
