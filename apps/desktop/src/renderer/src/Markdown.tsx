// Shared agent reply renderer for Ask and Trade. Raw HTML stays text; remote images
// stay descriptions, and only HTTPS links can open outside the app.
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`md${className ? ` ${className}` : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => (/^https:\/\/[^\s<>"']+$/i.test(url) ? url : "")}
        components={{
          a: ({ href, children }) => href ? (
            <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
          ) : <>{children}</>,
          img: ({ alt }) => <>{alt}</>,
          table: ({ children }) => (
            <div className="md-table" role="region" aria-label="Response table" tabIndex={0}>
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
