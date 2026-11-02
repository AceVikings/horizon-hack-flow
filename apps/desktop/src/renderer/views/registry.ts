// View registry: the only coupling point between app lanes. Each screen registers ONE line in VIEWS.
// Route = `#/<id>[/<param>...]`; params arrive as props. Shared UI lives in ../src/ui.tsx (cards, stats, bars,
// badges, tables, dialogs, QR, toasts) and ../src/app.tsx (useApp, useRemote); page parts in ../src/shell.tsx
// (<PageHead>, <ContextPanel>, <Inspector>, useMode, useNav, useKillSwitch). Components are default exports.
//
// Navigation follows docs/design/flow/SIMPLIFY.md: four rail items (Home · Ask · Trade · Activity) and a ⋯ menu.
// A view lands under a rail item or menu entry through its `id` (or `nav`). Simple mode is the default; views read
// `useMode()` and show their dense v1 panels in Pro mode. <Inspector> content only shows in Pro mode.
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/** Rail, in order. */
export const NAV = [
  { id: "home", name: "Home", icon: "home" },
  { id: "ask", name: "Ask", icon: "chat" },
  { id: "trade", name: "Trade", icon: "chart" },
  { id: "activity", name: "Activity", icon: "list" },
] as const;

/** ⋯ menu, in order. Unregistered ids show a "being built" page. */
export const MENU = [
  { id: "proof", name: "Safety & proof", icon: "shield" },
  { id: "agent", name: "Agent & strategy", icon: "bot" },
  { id: "tools", name: "Tools & guides", icon: "book" },
  { id: "charts", name: "Charts", icon: "chart" },
  { id: "accounts", name: "Accounts", icon: "key" },
  { id: "settings", name: "Settings", icon: "settings" },
  { id: "payments", name: "Payments", icon: "card", soon: true },
] as const;

export type NavId = (typeof NAV)[number]["id"] | (typeof MENU)[number]["id"];

/** Old v1 route ids → new ones (links and bookmarks keep working). */
export const ALIASES: Record<string, string> = { overview: "home", chat: "ask", markets: "trade", decisions: "activity", positions: "activity" };

export interface ViewProps {
  /** Path segments after the id: `#/activity/exec_8e8f` → ["exec_8e8f"]. */
  params: string[];
}
export interface ViewDef {
  /** Route id (unique). Use a NAV/MENU id to appear there. */
  id: string;
  component: LazyExoticComponent<ComponentType<ViewProps>> | ComponentType<ViewProps>;
  /** Rail/menu item to highlight (defaults to `id`). */
  nav?: NavId;
  /** "app" (default): rail + page. "setup": no rail; the view draws its own left column. The status bar always shows. */
  chrome?: "app" | "setup";
}

export const VIEWS: ViewDef[] = [
  // D1: Home, Trade, Activity
  // D2: Setup wizard (chrome "setup"), Settings, Accounts
  // D3: Ask (chat), Agent & strategy, Safety & proof, Payments
  { id: "home", component: lazy(() => import("./Overview")) },
  { id: "trade", component: lazy(() => import("./Markets")) },
  { id: "activity", component: lazy(() => import("./Activity")) },
];
