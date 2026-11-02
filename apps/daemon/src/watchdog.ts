// Parent-PID watchdog (desktop lane D2): a daemon the Flow app spawned exits when the app is gone, even if the app
// was killed without running its quit handlers. Enabled only when the app passes ATE_PARENT_PID (it does not when the
// user chose to keep the daemon running).

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Calls `onGone` once when `parentPid` no longer exists (or we were re-parented). Returns a stop function. */
export function watchParent(parentPid: number, onGone: () => void, o: { intervalMs?: number; alive?: (pid: number) => boolean; ppid?: () => number } = {}): () => void {
  const alive = o.alive ?? pidAlive;
  const ppid = o.ppid ?? (() => process.ppid);
  let fired = false;
  const t = setInterval(() => {
    if (fired) return;
    if (!alive(parentPid) || ppid() !== parentPid) {
      fired = true;
      clearInterval(t);
      onGone();
    }
  }, o.intervalMs ?? 2000);
  t.unref?.();
  return () => clearInterval(t);
}
