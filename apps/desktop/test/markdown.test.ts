import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "../src/renderer/src/md-parse";

describe("agent reply markdown", () => {
  it("parses bold, italics, inline code and https links only", () => {
    expect(parseInline("**Up** 2% on *low* volume, see `ate_chart` [docs](https://x.io/a)")).toEqual([
      { t: "b", c: [{ t: "text", v: "Up" }] },
      { t: "text", v: " 2% on " },
      { t: "i", c: [{ t: "text", v: "low" }] },
      { t: "text", v: " volume, see " },
      { t: "code", v: "ate_chart" },
      { t: "text", v: " " },
      { t: "a", href: "https://x.io/a", c: [{ t: "text", v: "docs" }] },
    ]);
    // javascript: and http: links lose the link and keep the text
    expect(parseInline("[x](javascript:alert(1))")).toEqual([{ t: "text", v: "x" }, { t: "text", v: ")" }]);
    expect(parseInline("[x](http://a.b)")).toEqual([{ t: "text", v: "x" }]);
    // snake_case and lone markers stay text; raw HTML stays text
    expect(parseInline("hsk_dex_pool 2 * 3 <b>hi</b>")).toEqual([{ t: "text", v: "hsk_dex_pool 2 * 3 <b>hi</b>" }]);
  });

  it("splits paragraphs, bullet and numbered lists, headings and code fences", () => {
    const b = parseMarkdown("## Chart\nThe chart is above.\n\n- **EMA 50**: 0.41\n- RSI 14: 58\n\n1. Support 0.39\n2. Resistance 0.44\n\n```\nraw\n```");
    expect(b.map((x) => x.t)).toEqual(["h", "p", "ul", "ol", "pre"]);
    expect(b[2]).toMatchObject({ t: "ul", items: [[{ t: "b" }, { t: "text", v: ": 0.41" }], [{ t: "text", v: "RSI 14: 58" }]] });
    expect(b[3]).toMatchObject({ t: "ol", start: 1 });
    expect((b[3] as { items: unknown[] }).items).toHaveLength(2);
    expect(b[4]).toEqual({ t: "pre", v: "raw" });
  });
});
