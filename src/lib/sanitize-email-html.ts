// Make provider-supplied email HTML safe to inject with dangerouslySetInnerHTML.
//
// Used by:
//   • components/master-inbox/thread-view.tsx (staff thread renderer)
//   • components/master-inbox/portals-ui/conversation-sheet.tsx (portal
//     conversation view)
//
// The body is written by whoever replied to a cold email, so it is hostile
// input. This used to strip only <style>, <script> and stylesheet <link> —
// which kept email CSS out of the app chrome but left every other script
// vector open: `<img src=x onerror=…>`, `<svg onload=…>`, `<a href="javascript:…">`
// and <iframe> all passed through and ran as the signed-in staff member.
//
// Now an ALLOWLIST, applied to a DOMParser document. DOMParser documents are
// inert — nothing in them loads or runs while we walk them — so the tree is
// cleaned before any of it reaches the live page:
//   • tags on DROP go with their content (script, style, iframe, svg, forms…);
//   • tags not on KEEP are unwrapped — their text stays, the element goes;
//   • attributes not on ATTRS are removed, which takes every on* handler and
//     `id`/`name` (so an email cannot clobber the page's own elements);
//   • href/src must be a safe URL; style loses script-bearing and
//     page-escaping declarations (position: fixed could draw over the app).
//
// Outside a browser (a server render) there is no DOMParser, and a regex
// cannot be trusted with hostile HTML, so the fallback returns escaped text.

const DROP = new Set([
  "script", "style", "link", "meta", "base", "title", "head", "noscript", "template",
  "iframe", "frame", "frameset", "object", "embed", "applet", "portal",
  "svg", "math", "canvas", "audio", "video", "source", "track",
  "form", "input", "button", "textarea", "select", "option", "optgroup", "datalist", "output",
]);

const KEEP = new Set([
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "big", "blockquote", "br",
  "caption", "center", "cite", "code", "col", "colgroup", "dd", "del", "details", "dfn", "div",
  "dl", "dt", "em", "figcaption", "figure", "font", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "i", "img", "ins", "kbd", "label", "li", "main", "mark", "nav", "ol", "p",
  "picture", "pre", "q", "s", "samp", "section", "small", "span", "strike", "strong", "sub",
  "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "tt", "u",
  "ul", "var", "wbr",
]);

const ATTRS = new Set([
  "href", "src", "alt", "title", "width", "height", "align", "valign", "bgcolor", "color",
  "face", "size", "border", "cellpadding", "cellspacing", "colspan", "rowspan", "style",
  "class", "dir", "lang", "start", "type", "target", "rel", "datetime", "span", "nowrap",
]);

/** A link or image address that cannot run script. Relative and fragment links are fine. */
export function safeUrl(raw: string, kind: "href" | "src"): string | null {
  // Browsers ignore control characters and whitespace inside a scheme
  // ("java\tscript:"), so the check must too.
  const url = raw.replace(/[\u0000- \u007f-\u009f]+/g, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (!scheme) return raw.trim();
  if (scheme === "http" || scheme === "https") return raw.trim();
  if (kind === "href" && (scheme === "mailto" || scheme === "tel")) return raw.trim();
  if (kind === "src" && scheme === "cid") return raw.trim();
  if (kind === "src" && /^data:image\/(png|jpe?g|gif|webp);/i.test(url)) return raw.trim();
  return null;
}

/** Inline CSS minus anything that runs script, loads a binding, or escapes the message box. */
export function cleanStyle(style: string): string {
  return style
    .split(";")
    .filter((decl) => {
      const d = decl.toLowerCase().replace(/\s+/g, "");
      if (!d) return false;
      if (/expression\(|javascript:|vbscript:|behavior:|-moz-binding|@import/.test(d)) return false;
      if (/^position:(fixed|sticky)/.test(d)) return false;
      if (/url\(/.test(d) && !/url\(["']?(https?:|cid:)/.test(d)) return false;
      return true;
    })
    .join(";");
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cleanElement(el: Element): void {
  for (const child of Array.from(el.children)) {
    const tag = child.tagName.toLowerCase();
    if (DROP.has(tag)) {
      child.remove();
      continue;
    }
    cleanElement(child);
    if (!KEEP.has(tag)) {
      child.replaceWith(...Array.from(child.childNodes));
      continue;
    }
    for (const attr of Array.from(child.attributes)) {
      const name = attr.name.toLowerCase();
      if (!ATTRS.has(name)) {
        child.removeAttribute(attr.name);
      } else if (name === "href" || name === "src") {
        const ok = safeUrl(attr.value, name);
        if (ok === null) child.removeAttribute(attr.name);
      } else if (name === "style") {
        child.setAttribute("style", cleanStyle(attr.value));
      }
    }
    // A link that opens a new tab must not hand the email's page our window.
    if (tag === "a" && child.hasAttribute("target")) {
      child.setAttribute("target", "_blank");
      child.setAttribute("rel", "noopener noreferrer");
    }
  }
  // Comments can hide conditional markup; they carry nothing a reader needs.
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 8) node.remove();
  }
}

export function sanitizeEmailHtml(html: string): string {
  if (typeof DOMParser === "undefined") {
    return escapeText(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  cleanElement(doc.body);
  return doc.body.innerHTML;
}
