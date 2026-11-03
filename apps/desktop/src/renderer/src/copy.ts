// Copy to the system clipboard. In the desktop app this goes through Electron main (navigator.clipboard can be
// refused in the app window); the web build falls back to navigator.clipboard, then a hidden textarea.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.ate?.copy && (await window.ate.copy(text))) return true;
  } catch {}
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  return ok;
}
