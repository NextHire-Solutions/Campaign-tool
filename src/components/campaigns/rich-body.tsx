"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import { sanitizeEmailHtml } from "@/lib/sanitize-email-html";

/*
 * The sequence body, edited as the email reads rather than as HTML (Eddy,
 * 1 Oct: "editing the body looks like this with HTML… can we make this look
 * more like Bison?").
 *
 * A plain contenteditable, not a rich-text library. Real bodies are
 * Gmail-style markup — <div> lines, <br>, styled <span>s — and an editor
 * library re-models that as <p> paragraphs and drops the styles, which
 * changes the spacing recipients see. Here the browser edits the markup in
 * place:
 *   · nothing is rewritten until someone types — an untouched step is saved
 *     byte for byte as it was;
 *   · spintax {Hi|Hello} and fields {FIRST_NAME} are plain text, so editing
 *     leaves them exactly as typed;
 *   · new lines are <div>s, matching the existing bodies;
 *   · paste arrives as plain text, so no foreign formatting comes in;
 *   · the HTML is shown through the email sanitiser, so a body can't run
 *     script in this page.
 */

export type RichFormat = "bold" | "italic" | "underline" | "link" | "break";

export interface RichBodyHandle {
  format(kind: RichFormat): void;
  insertText(text: string): void;
}

export const RichBody = forwardRef<RichBodyHandle, {
  value: string;
  onChange: (html: string) => void;
  minHeight?: number;
  ariaLabel?: string;
  className?: string;
  style?: React.CSSProperties;
}>(function RichBody({ value, onChange, minHeight = 220, ariaLabel = "Email body", className, style }, ref) {
  const el = useRef<HTMLDivElement | null>(null);
  /** The last HTML this editor reported — so its own changes aren't written back over the caret. */
  const emitted = useRef<string | null>(null);
  const range = useRef<Range | null>(null);

  useEffect(() => {
    if (!el.current || value === emitted.current) return;
    el.current.innerHTML = sanitizeEmailHtml(value ?? "");
    emitted.current = value;
  }, [value]);

  const save = () => {
    const s = window.getSelection();
    if (s && s.rangeCount && el.current?.contains(s.anchorNode)) range.current = s.getRangeAt(0).cloneRange();
  };
  const restore = () => {
    const node = el.current;
    const s = window.getSelection();
    if (!node || !s) return;
    node.focus();
    s.removeAllRanges();
    if (range.current && node.contains(range.current.startContainer)) {
      s.addRange(range.current);
    } else {
      const r = document.createRange();
      r.selectNodeContents(node);
      r.collapse(false);
      s.addRange(r);
    }
  };
  const emit = () => {
    if (!el.current) return;
    const html = el.current.innerHTML;
    emitted.current = html;
    onChange(html);
  };

  useImperativeHandle(ref, () => ({
    format(kind) {
      restore();
      if (kind === "link") {
        const url = window.prompt("Link address", "https://");
        if (!url || url === "https://") return;
        document.execCommand("createLink", false, /^(https?:|mailto:|tel:)/i.test(url) ? url : `https://${url}`);
      } else if (kind === "break") {
        if (!document.execCommand("insertLineBreak")) document.execCommand("insertHTML", false, "<br>");
      } else {
        document.execCommand(kind);
      }
      save();
      emit();
    },
    insertText(text) {
      restore();
      document.execCommand("insertText", false, text);
      save();
      emit();
    },
  }));

  return (
    <div
      ref={el}
      role="textbox"
      aria-multiline="true"
      aria-label={ariaLabel}
      contentEditable
      suppressContentEditableWarning
      spellCheck
      className={className}
      onFocus={() => { try { document.execCommand("defaultParagraphSeparator", false, "div"); } catch { /* older browsers */ } }}
      onInput={emit}
      onKeyUp={save}
      onMouseUp={save}
      onBlur={save}
      onPaste={(e) => {
        e.preventDefault();
        document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
        emit();
      }}
      style={{ minHeight, outline: "none", overflowWrap: "anywhere", ...style }}
    />
  );
});
