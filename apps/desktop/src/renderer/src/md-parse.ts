// Small, safe markdown for agent replies (Ask, Trade's "Ask about this chart"): paragraphs, bullet and numbered
// lists, headings (as bold lines), fenced code, and inline **bold**, *italic*, `code`, [links](https://…).
// Pure parser → a tiny AST; the React renderer (Markdown.tsx) builds elements from it. Never produces HTML strings,
// so nothing the model writes is ever injected as markup.

export type Inline = { t: "text"; v: string } | { t: "b"; c: Inline[] } | { t: "i"; c: Inline[] } | { t: "code"; v: string } | { t: "a"; href: string; c: Inline[] };
export type Block = { t: "p"; c: Inline[] } | { t: "h"; c: Inline[] } | { t: "ul"; items: Inline[][] } | { t: "ol"; start: number; items: Inline[][] } | { t: "pre"; v: string };

const SAFE_URL = /^https:\/\/[^\s<>"']+$/i;

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "\\" && i + 1 < s.length && /[*_`[\]\\]/.test(s[i + 1]!)) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const j = s.indexOf("`", i + 1);
      if (j > i + 1) {
        flush();
        out.push({ t: "code", v: s.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && s[i + 1] === ch) {
      const j = s.indexOf(ch + ch, i + 2);
      if (j > i + 2) {
        flush();
        out.push({ t: "b", c: parseInline(s.slice(i + 2, j)) });
        i = j + 2;
        continue;
      }
    }
    if (ch === "*" || ch === "_") {
      // italic: an opening marker followed by a non-space, closed by the same marker after a non-space;
      // `_` only at a word boundary (snake_case ids stay as they are)
      const prev = s[i - 1];
      const okOpen = s[i + 1] !== undefined && s[i + 1] !== " " && s[i + 1] !== ch && (ch === "*" || !prev || !/\w/.test(prev));
      if (okOpen) {
        let j = i + 1;
        while ((j = s.indexOf(ch, j)) !== -1) {
          const after = s[j + 1];
          if (s[j - 1] !== " " && s[j + 1] !== ch && (ch === "*" || !after || !/\w/.test(after))) break;
          j++;
        }
        if (j > i + 1) {
          flush();
          out.push({ t: "i", c: parseInline(s.slice(i + 1, j)) });
          i = j + 1;
          continue;
        }
      }
    }
    if (ch === "[") {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(s.slice(i));
      if (m) {
        flush();
        if (SAFE_URL.test(m[2]!)) out.push({ t: "a", href: m[2]!, c: parseInline(m[1]!) });
        else out.push(...parseInline(m[1]!));
        i += m[0].length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

const UL = /^\s*[-*•]\s+(.*)$/;
const OL = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const H = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) out.push({ t: "p", c: parseInline(para.join("\n")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s*```/.test(l)) {
      endPara();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i++]!);
      out.push({ t: "pre", v: code.join("\n") });
      continue;
    }
    if (!l.trim()) {
      endPara();
      continue;
    }
    const h = H.exec(l);
    if (h) {
      endPara();
      out.push({ t: "h", c: parseInline(h[1]!) });
      continue;
    }
    const u = UL.exec(l);
    const o = u ? null : OL.exec(l);
    if (u || o) {
      endPara();
      const prev = out[out.length - 1];
      const item = parseInline((u ? u[1] : o![2])!);
      // a blank line between items of the same kind keeps one list
      const contiguous = i > 0 && (lines[i - 1]!.trim() === "" ? true : UL.test(lines[i - 1]!) || OL.test(lines[i - 1]!));
      if (u && prev?.t === "ul" && contiguous) prev.items.push(item);
      else if (o && prev?.t === "ol" && contiguous) prev.items.push(item);
      else out.push(u ? { t: "ul", items: [item] } : { t: "ol", start: Number(o![1]), items: [item] });
      continue;
    }
    // an indented continuation line belongs to the last list item
    const last = out[out.length - 1];
    if (!para.length && /^\s{2,}\S/.test(l) && (last?.t === "ul" || last?.t === "ol") && i > 0 && lines[i - 1]!.trim() !== "") {
      last.items[last.items.length - 1]!.push({ t: "text", v: " " }, ...parseInline(l.trim()));
      continue;
    }
    para.push(l);
  }
  endPara();
  return out;
}
