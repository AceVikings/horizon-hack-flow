import { describe, expect, it } from "vitest";
import { DrawingsPrimitive, fibLevels, timeForLogical, xForTime } from "../src/renderer/src/charts/drawings";

const times = [1000, 1060, 1120, 1180];
const lx = (l: number) => 100 + l * 10; // logical → x

describe("drawing coordinates", () => {
  it("maps times to x: on bars, between bars and past both ends", () => {
    expect(xForTime(1060, times, lx)).toBe(110);
    expect(xForTime(1090, times, lx)).toBe(115);
    expect(xForTime(1240, times, lx)).toBe(140);
    expect(xForTime(940, times, lx)).toBe(90);
  });
  it("timeForLogical inverts it", () => {
    expect(timeForLogical(1.5, times)).toBe(1090);
    expect(timeForLogical(4, times)).toBe(1240);
    expect(timeForLogical(-1, times)).toBe(940);
  });
  it("Fibonacci levels run from the swing end back to the start", () => {
    const f = fibLevels(100, 200);
    expect(f[0]).toEqual({ r: 0, v: 200 });
    expect(f.find((x) => x.r === 0.5)!.v).toBe(150);
    expect(f.find((x) => x.r === 0.618)!.v).toBeCloseTo(138.2);
    expect(f.at(-1)).toEqual({ r: 1, v: 100 });
  });
});

describe("drawings render through the series primitive", () => {
  function setup() {
    const ops: string[] = [];
    const ctx = new Proxy(
      { font: "", fillStyle: "", strokeStyle: "", lineWidth: 1, measureText: (t: string) => ({ width: t.length * 6 }), setLineDash: () => {} },
      {
        get(t, k: string) {
          if (k in t) return (t as Record<string, unknown>)[k];
          return (...a: unknown[]) => ops.push(`${k}(${a.map((x) => (typeof x === "number" ? Math.round(x) : x)).join(",")})`);
        },
        set(t, k: string, v) {
          (t as Record<string, unknown>)[k] = v;
          return true;
        },
      },
    );
    const p = new DrawingsPrimitive();
    const series = { data: () => times.map((time) => ({ time })), priceToCoordinate: (v: number) => 500 - v };
    const chart = { timeScale: () => ({ logicalToCoordinate: lx }) };
    p.attached({ chart, series, requestUpdate: () => {} } as never);
    const draw = () => p.paneViews()[0]!.renderer()!.draw({ useMediaCoordinateSpace: (cb: (s: unknown) => void) => cb({ context: ctx, mediaSize: { width: 400, height: 300 } }) } as never);
    return { p, ops, draw };
  }
  it("a level spans the width at its price, with its label", () => {
    const { p, ops, draw } = setup();
    p.set([{ kind: "hline", a: { v: 200 }, label: "Support $200", role: "support" }], null, null);
    draw();
    expect(ops).toContain("moveTo(0,300)");
    expect(ops).toContain("lineTo(400,300)");
    expect(ops.some((o) => o.startsWith("fillText(Support $200"))).toBe(true);
  });
  it("a trendline joins its two points; a zone fills between prices; a note sits at its point", () => {
    const { p, ops, draw } = setup();
    p.set(
      [
        { kind: "trend", a: { t: 1000, v: 100 }, b: { t: 1180, v: 160 } },
        { kind: "zone", a: { v: 120 }, b: { v: 140 }, label: "Zone" },
        { kind: "text", a: { t: 1120, v: 150 }, label: "Breakout" },
      ],
      null,
      null,
    );
    draw();
    expect(ops).toContain("moveTo(100,400)");
    expect(ops).toContain("lineTo(130,340)");
    expect(ops).toContain("fillRect(0,360,400,20)");
    expect(ops.some((o) => o.startsWith("fillText(Breakout"))).toBe(true);
  });
  it("Fibonacci draws seven labelled levels", () => {
    const { p, ops, draw } = setup();
    p.set([{ kind: "fib", a: { t: 1000, v: 100 }, b: { t: 1180, v: 200 } }], null, null);
    draw();
    expect(ops.filter((o) => o.startsWith("fillText(") && o.includes("%")).length).toBe(7);
    expect(ops.some((o) => o.startsWith("fillText(61.8%"))).toBe(true);
  });
});
