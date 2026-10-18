import { Fragment, type ReactNode } from "react";
import { linkLabelMismatch, parseMarkdown, type Block, type Inline } from "@/lib/markdown";

/**
 * Renders the safe Markdown tree (src/lib/markdown.ts) as React elements. There is no dangerouslySetInnerHTML anywhere: text is
 * escaped by React, element and attribute names come from this file only, and a link's destination was validated as http(s).
 * Headings are drawn as bold paragraphs so a comment can never break the page's heading outline.
 */
function inline(nodes: Inline[], newTab: string, key = ""): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
      case "text": return <Fragment key={k}>{n.v}</Fragment>;
      case "br": return <br key={k} />;
      case "code": return <code key={k}>{n.v}</code>;
      case "strong": return <strong key={k}>{inline(n.c, newTab, k)}</strong>;
      case "em": return <em key={k}>{inline(n.c, newTab, k)}</em>;
      case "del": return <del key={k}>{inline(n.c, newTab, k)}</del>;
      case "link": {
        const real = linkLabelMismatch(n.c, n.href);
        return (
          <Fragment key={k}>
            <a href={n.href} target="_blank" rel="noopener noreferrer nofollow ugc">{inline(n.c, newTab, k)}<span className="sr-only"> ({newTab})</span></a>
            {real && <span className="muted small"> [→ {real}]</span>}
          </Fragment>
        );
      }
    }
  });
}

function blocks(nodes: Block[], newTab: string, key = ""): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
      case "p": return <p key={k}>{inline(n.c, newTab, k)}</p>;
      case "heading": return <p key={k} className="md-heading"><strong>{inline(n.c, newTab, k)}</strong></p>;
      case "code": return <pre key={k}><code>{n.v}</code></pre>;
      case "quote": return <blockquote key={k}>{blocks(n.c, newTab, k)}</blockquote>;
      case "hr": return <hr key={k} />;
      case "list": {
        const items = n.items.map((it, j) => <li key={`${k}-${j}`}>{blocks(it, newTab, `${k}-${j}`)}</li>);
        return n.ordered ? <ol key={k} start={n.start}>{items}</ol> : <ul key={k}>{items}</ul>;
      }
    }
  });
}

export function renderMarkdown(source: string, newTabLabel = "opens in a new tab"): ReactNode {
  return blocks(parseMarkdown(source), newTabLabel);
}

export function Markdown({ source, newTabLabel }: { source: string; newTabLabel?: string }) {
  return <div className="md">{renderMarkdown(source, newTabLabel)}</div>;
}
