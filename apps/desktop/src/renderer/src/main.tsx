import { StrictMode, Suspense, useEffect, useState, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "./app";
import { PageHead, Shell } from "./shell";
import { Skeleton } from "./ui";
import { ALIASES, VIEWS, type ViewDef, type ViewProps } from "../views/registry";
import "./styles.css";

/** `#/decisions/exec_1` → { id: "decisions", params: ["exec_1"] }. */
function parseHash(): { id: string; params: string[] } {
  const [id = "", ...params] = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  return { id: ALIASES[id] ?? (id || "home"), params };
}

function NotBuilt({ id }: { id: string }) {
  return (
    <>
      <PageHead title={id.charAt(0).toUpperCase() + id.slice(1)} sub="This screen is being built in another lane." />
      <p className="fg2">Nothing is registered for <code>#/{id}</code> in views/registry.ts yet.</p>
    </>
  );
}

function Loading() {
  return (
    <div style={{ paddingTop: 26 }} aria-busy="true">
      <Skeleton w={220} h={44} />
      <Skeleton h={180} style={{ marginTop: 28 }} />
    </div>
  );
}

function Root() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const h = () => setRoute(parseHash());
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);
  const def: ViewDef | undefined = VIEWS.find((v) => v.id === route.id);
  const V = (def?.component ?? (() => <NotBuilt id={route.id} />)) as ComponentType<ViewProps>;
  const chrome = def?.chrome ?? "app";
  return (
    <AppProvider>
      <Shell nav={def?.nav ?? route.id} chrome={chrome} setupStep={chrome === "setup" ? Number(route.params[0] ?? 0) || 0 : undefined}>
        <Suspense fallback={<Loading />}>
          <V key={route.id + "/" + route.params.join("/")} params={route.params} />
        </Suspense>
      </Shell>
    </AppProvider>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
