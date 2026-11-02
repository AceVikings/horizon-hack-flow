import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "./app";
import { Shell, VIEWS, type ViewId } from "./shell";
import Decisions from "./views/Decisions";
import Trade from "./views/Trade";
import Agents from "./views/Agents";
import Positions from "./views/Positions";
import Chat from "./views/Chat";
import Payments from "./views/Payments";
import "./styles.css";

const MAP: Record<ViewId, () => React.JSX.Element> = { decisions: Decisions, trade: Trade, agents: Agents, positions: Positions, chat: Chat, payments: Payments };
const fromHash = (): ViewId => {
  const h = location.hash.replace(/^#\/?/, "") as ViewId;
  return VIEWS.some((v) => v.id === h) ? h : "decisions";
};

function Root() {
  const [view, setView] = useState<ViewId>(fromHash);
  useEffect(() => {
    const h = () => setView(fromHash());
    window.addEventListener("hashchange", h);
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && /^[1-6]$/.test(e.key)) { location.hash = "#/" + VIEWS[Number(e.key) - 1]!.id; e.preventDefault(); }
    };
    window.addEventListener("keydown", k);
    return () => { window.removeEventListener("hashchange", h); window.removeEventListener("keydown", k); };
  }, []);
  const V = MAP[view];
  return (
    <AppProvider>
      <Shell view={view} setView={(v) => (location.hash = "#/" + v)}>
        <V key={view} />
      </Shell>
    </AppProvider>
  );
}
createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
