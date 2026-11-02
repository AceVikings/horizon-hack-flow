// Desktop builds live on the GitHub release; null = not built yet (button shows "Coming soon").
const BASE = "https://github.com/AceVikings/horizon-hack-flow/releases/latest/download";

export const downloads: { mac: string | null; win: string | null } = {
  mac: `${BASE}/Flow-mac-arm64.dmg`,
  win: null,
};
