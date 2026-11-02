// Agent replies as safe markdown (one component for Ask and Trade's "Ask about this chart"). React elements only:
// text is always a text node, links are https only and open outside the app.
import { Fragment, type ReactNode } from "react";
import { parseMarkdown, type Inline } from "./md-parse";

function inl(xs: Inline[]): ReactNode[] {
  return xs.map((x, i) => {
    switch (x.t) {
      case "text":
        return <Fragment key={i}>{x.v}</Fragment>;
      case "b":
        return <strong key={i}>{inl(x.c)}</strong>;
      case "i":
        return <em key={i}>{inl(x.c)}</em>;
      case "code":
        return <code key={i}>{x.v}</code>;
      case "a":
        return (
          <a key={i} href={x.href} target="_blank" rel="noopener noreferrer">
            {inl(x.c)}
          </a>
        );
    }
  });
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div className={`md${className ? ` ${className}` : ""}`}>
      {blocks.map((b, i) => {
        switch (b.t) {
          case "p":
            return <p key={i}>{inl(b.c)}</p>;
          case "h":
            return (
              <p key={i} className="mdh">
                <strong>{inl(b.c)}</strong>
              </p>
            );
          case "ul":
            return (
              <ul key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inl(it)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} start={b.start}>
                {b.items.map((it, j) => (
                  <li key={j}>{inl(it)}</li>
                ))}
              </ol>
            );
          case "pre":
            return (
              <pre key={i}>
                <code>{b.v}</code>
              </pre>
            );
        }
      })}
    </div>
  );
}
