import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/renderer/src/Markdown";

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe("agent reply markdown", () => {
  it("renders heading levels, nested lists, quotes and inline formatting", () => {
    const html = render("# Summary\n\n## Positions\n\n- **BTC**\n  - *Holding* `0.01`\n\n3. Review\n4. Confirm\n\n> Keep ~~old~~ new limits.\n\n---");
    expect(html).toContain("<h1>Summary</h1>");
    expect(html).toContain("<h2>Positions</h2>");
    expect(html).toMatch(/<ul>\s*<li><strong>BTC<\/strong>\s*<ul>\s*<li><em>Holding<\/em> <code>0.01<\/code>/);
    expect(html).toContain('<ol start="3">');
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<del>old</del>");
    expect(html).toContain("<hr/>");
  });

  it("renders GFM tables, task lists and autolinks", () => {
    const html = render("| Asset | Value |\n| :--- | ---: |\n| BTC | **$100** |\n\n- [x] Reviewed\n- [ ] Pending\n\nhttps://example.com/report");
    expect(html).toContain('class="md-table" role="region" aria-label="Response table" tabindex="0"');
    expect(html).toContain("<thead>");
    expect(html).toContain("<strong>$100</strong>");
    expect(html).toContain('class="task-list-item"');
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*checked=""/);
    expect(html).toContain('href="https://example.com/report" target="_blank" rel="noopener noreferrer"');
  });

  it("preserves fenced code, escaped syntax, snake case and partial replies", () => {
    const html = render('Escaped \\*literal\\* hsk_dex_pool\n\n```json\n{"html": "<b>hi</b>", "value": "**raw**"}\n```');
    expect(html).toContain("Escaped *literal* hsk_dex_pool");
    expect(html).toContain('<pre><code class="language-json">');
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;');
    expect(html).toContain("**raw**");
    expect(render("Working **on it")).toContain("Working **on it");
    expect(render("```ts\nconst pending = 1;")).toContain('<pre><code class="language-ts">const pending = 1;');
  });

  it("keeps raw HTML inert and strips unsafe links and remote images", () => {
    const html = render('<script>alert(1)</script>\n\n<b onclick="bad()">hi</b>\n\n[safe](https://example.com/path?q=1) [http](http://example.com) [file](file:///etc/passwd) [script](javascript:alert%281%29) [data](data:text/html,bad) [relative](/settings)\n\n![Chart](https://example.com/tracker.png)');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toMatch(/<script|<b\s|<img/);
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('href="https://example.com/path?q=1"');
    expect(html).toContain("Chart");
    expect(html).not.toContain("tracker.png");
  });
});
