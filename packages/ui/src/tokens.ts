// ATE design tokens as TS (mirror of tokens.css). Source of truth: docs/design/DESIGN-LANGUAGE.md.
export const color = {
  charcoal: "#171e19",
  dark: "#272727",
  sage: "#b7c6c2",
  white: "#ffffff",
  yellow: "#ffe17c",
  surface: "#f8f9fa",
} as const;

export const status = {
  light: { ok: "#13744a", bad: "#b3202d", warn: "#855800", info: "#1d5a8e" },
  dark: { ok: "#7fdcaa", bad: "#ff8d95", warn: "#ffe17c", info: "#a8ccf3" },
} as const;

export const font = {
  display: '"Anton", Impact, "Arial Narrow", sans-serif',
  body: '"Satoshi", "Figtree", -apple-system, system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, monospace',
  displayLeading: 0.9,
  bodyWeights: [400, 500, 700],
} as const;

export const line = {
  light: "rgba(23, 30, 25, 0.1)",
  dark: "rgba(183, 198, 194, 0.1)",
} as const;

export const grid = {
  size: 40,
  background: "linear-gradient(to right, #b7c6c220 1px, transparent 1px), linear-gradient(to bottom, #b7c6c220 1px, transparent 1px)",
} as const;

export const motion = { ease: "cubic-bezier(0.4, 0, 0.2, 1)", durationMs: 300 } as const;

/** Highlight bar behind key words: #ffe17c parallelogram slanted 15°. */
export const highlight = { color: "#ffe17c", angleDeg: 15 } as const;

export const tokens = { color, status, font, line, grid, motion, highlight } as const;
export type Tokens = typeof tokens;
