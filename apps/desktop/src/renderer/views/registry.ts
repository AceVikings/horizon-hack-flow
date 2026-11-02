// View registry: the only coupling point between app lanes. Each screen registers ONE line below.
// Route = `#/<id>[/<param>...]`; params arrive as props. Shared UI lives in ../src/ui.tsx (cards, stats,
// bars, badges, tables, dialogs, QR, toasts) and ../src/app.tsx (useApp, useRemote); page slots in ../src/shell.tsx
// (<PageHead>, <ContextPanel>, <Inspector>). Components are default exports, loaded lazily.
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/** Left-rail items, in rail order. `payments` is disabled ("soon") in v1. */
export const NAV = [
  { id: "overview", name: "Overview", icon: "home" },
  { id: "decisions", name: "Decisions", icon: "list" },
  { id: "markets", name: "Markets", icon: "chart" },
  { id: "positions", name: "Positions", icon: "pie" },
  { id: "agent", name: "Agent", icon: "bot" },
  { id: "chat", name: "Chat", icon: "chat" },
  { id: "proof", name: "Proof", icon: "shield" },
  { id: "payments", name: "Payments", icon: "card", soon: true },
] as const;
export type NavId = (typeof NAV)[number]["id"] | "settings";

export interface ViewProps {
  /** Path segments after the id: `#/decisions/exec_8e8f` → ["exec_8e8f"]. */
  params: string[];
}
export interface ViewDef {
  /** Route id (unique). */
  id: string;
  component: LazyExoticComponent<ComponentType<ViewProps>> | ComponentType<ViewProps>;
  /** Rail item to highlight (defaults to `id`). */
  nav?: NavId;
  /** "app" (default): rail + page. "setup": no rail; the view draws its own left column. The evidence footer always shows. */
  chrome?: "app" | "setup";
}

export const VIEWS: ViewDef[] = [
  // D1: Overview, Decisions, Markets, Positions
  // D2: Setup wizard, Settings
  // D3: Agent, Chat, Proof, Payments
  { id: "overview", component: lazy(() => import("./Overview")) },
  { id: "decisions", component: lazy(() => import("./Decisions")) },
  { id: "markets", component: lazy(() => import("./Markets")) },
  { id: "positions", component: lazy(() => import("./Positions")) },
];
