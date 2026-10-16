import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

/**
 * Lab descriptions are Markdown (GitHub flavour: tables, task lists, strikethrough),
 * plus GitHub's callouts:  > [!NOTE]  > [!TIP]  > [!IMPORTANT]  > [!WARNING]  > [!CAUTION]
 * A single line break is kept as a line break, so descriptions written as plain text
 * look as they did. Raw HTML is not rendered: lab files get shared, and a lab from
 * someone else mustn't be able to run code in your DockerLab.
 */

const ALERTS = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" };

/** remark plugin: a blockquote starting with [!TYPE] becomes a callout. */
function remarkAlerts() {
  const walk = (node) => {
    if (node.type === "blockquote") {
      const p = node.children?.[0];
      const t = p?.type === "paragraph" && p.children?.[0];
      const m = t?.type === "text" && /^\[!(\w+)\][ \t]*(\n|$)/.exec(t.value);
      const kind = m && m[1].toLowerCase();
      if (kind && ALERTS[kind]) {
        t.value = t.value.slice(m[0].length);
        if (!t.value) p.children.shift();
        if (p.children[0]?.type === "break") p.children.shift();   // remark-breaks' break after the marker
        if (!p.children.length) node.children.shift();
        node.data = { hName: "aside", hProperties: { className: ["md-alert", `md-${kind}`], "data-title": ALERTS[kind] } };
      }
    }
    node.children?.forEach(walk);
  };
  return walk;
}

function CodeBlock({ children, ...rest }) {
  const [copied, setCopied] = useState(false);
  const text = () => {
    const c = Array.isArray(children) ? children[0] : children;
    return String(c?.props?.children ?? "").replace(/\n$/, "");
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(text()); setCopied(true); setTimeout(() => setCopied(false), 1200); }
    catch { /* no clipboard (plain http on another host): select it by hand */ }
  };
  return (
    <div className="md-pre">
      <pre {...rest}>{children}</pre>
      <button type="button" className="md-copy" onClick={copy} title="Copy">{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

const components = {
  a: ({ node, ...p }) => <a {...p} target="_blank" rel="noopener noreferrer" />,   // eslint-disable-line no-unused-vars
  pre: ({ node, ...p }) => <CodeBlock {...p} />,                                     // eslint-disable-line no-unused-vars
  img: ({ node, alt, ...p }) => <img {...p} alt={alt ?? ""} loading="lazy" />,       // eslint-disable-line no-unused-vars
};

export default function Markdown({ text, className = "" }) {
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks, remarkAlerts]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export const MARKDOWN_HELP = [
  ["## Heading", "a heading"],
  ["**bold**  *italic*", "emphasis"],
  ["`ip -br a`", "a command in text"],
  ["```\\ncommand\\n```", "a block of commands, with a Copy button"],
  ["1. step  /  - item", "lists"],
  ["- [ ] task", "a checklist"],
  ["> [!TIP]", "a callout: NOTE, TIP, IMPORTANT, WARNING, CAUTION"],
  ["| a | b |", "a table"],
  ["[text](https://…)", "a link"],
];
