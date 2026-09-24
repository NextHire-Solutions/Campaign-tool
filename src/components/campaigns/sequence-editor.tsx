"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  GripVertical,
  ChevronDown,
  ChevronUp,
  Loader2,
  Plus,
  Trash2,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmailPanel } from "@/components/analytics/email-panel";
import { countVariations } from "@/lib/spintax.ts";
import { campaignKey } from "@/lib/campaigns/query-keys.ts";
import { cn } from "@/lib/utils";
import { CopyTagsPanel } from "@/components/campaigns/copy-tags-panel";

/*
 * The sequence editor (spec §9.3).
 *
 * "Changes are saved only when you press Save. If you try to leave with unsaved
 * edits, you'll be warned. Nothing goes live by accident."
 *
 * Everything below is local state until Save. The component never mutates the
 * server copy, and the Save button is the only thing that can.
 *
 * Reordering is BOTH drag and buttons (§9.3 asks for drag). An earlier pass
 * shipped buttons only, arguing a mis-drag was "a one-slip mistake with no
 * undo" — but nothing here is saved until Save, so a mis-drag is undone by
 * dragging back or by leaving. The real objection was keyboard access, which
 * the buttons still provide. Both, rather than either.
 *
 * Formatting wraps the selection in HTML tags rather than using a WYSIWYG
 * editor, and that is deliberate. Bodies are HTML (297 of 299 steps) but they
 * also carry spintax `{a|b}` and merge tags `{FIRST_NAME}` in the SAME single
 * braces. Every contenteditable surface normalises markup on input, which would
 * rewrite or split those. Wrapping a selection leaves every other byte untouched.
 */

/*
 * Fallback only. The real list comes from /api/merge-tags, built from the lead
 * custom variables this workspace actually has — the constant that used to live
 * here offered {COMPANY_NAME}, {JOB_TITLE}, {CITY} and {STATE}, none of which
 * appear in any of the 299 steps or map to anything on a lead.
 */
const FALLBACK_MERGE_TAGS = ["{FIRST_NAME}", "{LAST_NAME}", "{EMAIL}", "{COMPANY}"];

/** Wraps the selection. Kept to tags EmailBison renders in an email body. */
const FORMATS = [
  { label: "B", title: "Bold", open: "<strong>", close: "</strong>", className: "font-bold" },
  { label: "I", title: "Italic", open: "<em>", close: "</em>", className: "italic" },
  { label: "U", title: "Underline", open: "<u>", close: "</u>", className: "underline" },
  { label: "¶", title: "Paragraph", open: "<p>", close: "</p>", className: "" },
  { label: "↵", title: "Line break", open: "<br>", close: "", className: "" },
] as const;

export interface EditableStep {
  /** Absent = added in this session, not yet on EmailBison. */
  id?: number;
  email_subject: string;
  email_body: string;
  wait_in_days: number;
  thread_reply: boolean;
  variant: boolean;
  variant_from_step_id?: number | null;
  /** Local key so React can track rows that have no id yet. */
  key: string;
}

export function SequenceEditor({
  campaignId,
  sequenceId,
  initial,
  sentStepIds,
  onDone,
}: {
  campaignId: number;
  sequenceId: number | null;
  initial: EditableStep[];
  /** Steps EmailBison will refuse to delete. */
  sentStepIds: number[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [steps, setSteps] = useState<EditableStep[]>(initial);
  const [open, setOpen] = useState<string | null>(initial[0]?.key ?? null);
  const bodyRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const sent = new Set(sentStepIds);
  const dirty = JSON.stringify(steps) !== JSON.stringify(initial);

  /*
   * §9.3: "If you try to leave with unsaved edits, you'll be warned. Nothing
   * goes live by accident." The promise was in the file's own header comment
   * and nothing implemented it — closing the tab discarded the work silently.
   *
   * `beforeunload` covers reload, tab close and navigation away from the app.
   * It cannot cover an in-app route change, which React Router-style
   * navigation performs without unloading; the Save/Discard bar stays visible
   * for that case, which is why it is pinned rather than inline.
   */
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Browsers ignore custom text now and show their own wording; assigning
      // returnValue is still what triggers the prompt at all.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const { data: mergeTags } = useQuery<{ tags: string[] }>({
    queryKey: ["merge-tags"],
    queryFn: async () => {
      const response = await fetch("/api/merge-tags");
      if (!response.ok) throw new Error("Failed to load merge tags");
      return response.json();
    },
    staleTime: 5 * 60_000,
  });
  const tags = mergeTags?.tags?.length ? mergeTags.tags : FALLBACK_MERGE_TAGS;

  const save = useMutation({
    mutationFn: async () => {
      if (!sequenceId) {
        throw new Error(
          "This campaign has no sequence id cached yet. Run sync-entities, then reload.",
        );
      }
      const response = await fetch(`/api/campaigns/${campaignId}/sequence`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sequenceId,
          steps: steps.map((s) => ({
            id: s.id,
            email_subject: s.email_subject,
            email_body: s.email_body,
            wait_in_days: s.wait_in_days,
            thread_reply: s.thread_reply,
            variant: s.variant,
            variant_from_step_id: s.variant_from_step_id ?? null,
          })),
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(
          body.partiallyApplied
            ? `${body.error}\n\nPart of the save was applied (${body.partiallyApplied.updated} updated, ` +
              `${body.partiallyApplied.added} added, ${body.partiallyApplied.deleted} deleted). ` +
              `Reload before trying again.`
            : (body.error ?? "The sequence could not be saved"),
        );
      }
      return body;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: campaignKey(campaignId) });
      onDone();
    },
  });

  function update(index: number, patch: Partial<EditableStep>) {
    setSteps(steps.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    setSteps(next);
  }

  /**
   * Drag reorder (§9.3), moving the dragged step to the drop position.
   *
   * Not a swap. `move` swaps because it steps one place at a time, but dragging
   * step 1 onto step 4 must leave 2 and 3 shifted up — a swap there would
   * silently reorder two steps the user never touched.
   */
  function reorder(from: number, to: number) {
    if (from === to || to < 0 || to >= steps.length) return;
    const next = [...steps];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setSteps(next);
  }

  function remove(index: number) {
    setSteps(steps.filter((_, i) => i !== index));
  }

  function add() {
    const key = `new-${Date.now()}`;
    setSteps([
      ...steps,
      {
        key,
        email_subject: "",
        email_body: "",
        // Defaults that match the workspace's dominant pattern rather than
        // zeros, which would send the whole sequence at once.
        wait_in_days: 1,
        thread_reply: steps.length > 0,
        variant: false,
      },
    ]);
    setOpen(key);
  }

  /**
   * Wraps the current selection, or inserts at the cursor when nothing is
   * selected. Operates on the raw text so spintax and merge tags survive byte
   * for byte — the reason this is not a WYSIWYG editor.
   */
  function wrap(index: number, open: string, close: string) {
    const field = bodyRefs.current[steps[index].key];
    const body = steps[index].email_body;
    if (!field) return update(index, { email_body: body + open + close });

    const start = field.selectionStart ?? body.length;
    const end = field.selectionEnd ?? start;
    const next = body.slice(0, start) + open + body.slice(start, end) + close + body.slice(end);
    update(index, { email_body: next });

    queueMicrotask(() => {
      field.focus();
      // Leave the wrapped text selected so a second format can be applied, and
      // put the caret inside the tags when nothing was selected.
      field.setSelectionRange(start + open.length, end + open.length);
    });
  }

  /** Inserts at the cursor rather than appending — §9.3 asks for a menu, not typing. */
  function insertTag(index: number, tag: string) {
    const field = bodyRefs.current[steps[index].key];
    const body = steps[index].email_body;
    if (!field) return update(index, { email_body: body + tag });
    const start = field.selectionStart ?? body.length;
    const end = field.selectionEnd ?? start;
    update(index, { email_body: body.slice(0, start) + tag + body.slice(end) });
    queueMicrotask(() => {
      field.focus();
      field.setSelectionRange(start + tag.length, start + tag.length);
    });
  }

  /*
   * Centred and wider than the read view. Left-aligned at max-w-4xl it left a
   * third of a wide screen empty beside the one screen here people actually
   * type into — the body textarea benefits from the room, and the eye should
   * not have to travel from a left-hugging form across empty space.
   */
  return (
    <div className="mx-auto max-w-5xl space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
        <span className="text-xs font-medium">Editing sequence</span>
        <span className="text-[11px] text-muted-foreground">
          Nothing is sent to EmailBison until you press Save.
        </span>
        <div className="ml-auto flex items-center gap-2">
          {dirty ? (
            <span className="text-[11px] text-amber-700">Unsaved changes</span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            disabled={!dirty || save.isPending}
            onClick={() => setSteps(initial)}
          >
            <Undo2 className="size-3" />
            Revert
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={save.isPending}
            onClick={() => {
              // §9.3: warned before losing edits.
              if (
                dirty &&
                !window.confirm("Discard your unsaved changes to this sequence?")
              ) {
                return;
              }
              onDone();
            }}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={!dirty || save.isPending || steps.length === 0}
            onClick={() => save.mutate()}
          >
            {save.isPending ? <Loader2 className="mr-1.5 size-3 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </div>

      {save.error ? (
        <p className="whitespace-pre-line rounded-md border border-red-300/60 bg-red-50 p-2.5 text-xs text-red-800">
          {save.error.message}
        </p>
      ) : null}

      {steps.map((step, index) => {
        const isNew = step.id == null;
        const locked = step.id != null && sent.has(step.id);
        const variations = countVariations(step.email_body);

        return (
          <div key={step.key} className="rounded-lg border">
            <div
              /*
               * Drop target. `dragOver` must preventDefault or the browser
               * refuses the drop entirely — the single most common reason
               * native HTML5 drag "does nothing".
               */
              onDragOver={(e) => {
                if (dragIndex === null) return;
                e.preventDefault();
                setDropIndex(index);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null) reorder(dragIndex, index);
                setDragIndex(null);
                setDropIndex(null);
              }}
              className={cn(
                "flex items-center gap-2 border-b px-3 py-2",
                dropIndex === index && dragIndex !== index && "bg-accent",
                dragIndex === index && "opacity-40",
              )}
            >
              {/*
                Only the handle is draggable, not the row: a draggable row makes
                selecting the subject text start a drag instead.
              */}
              <span
                draggable
                onDragStart={() => setDragIndex(index)}
                onDragEnd={() => {
                  setDragIndex(null);
                  setDropIndex(null);
                }}
                title="Drag to reorder"
                aria-hidden
                className="shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing"
              >
                <GripVertical className="size-3.5" />
              </span>

              {/*
                Numbered by POSITION IN THE SEQUENCE, not by row index. The
                editor keeps a flat list because EmailBison's sequence is flat
                and saving a nested shape would have to invent an ordering — but
                numbering the rows 1..N made a variant read as "step 4" of a
                3-step campaign, which is what the Campaigns table was fixed for
                in 043. A variant shows which step it belongs to instead.
              */}
              <span
                className={cn(
                  "tnum shrink-0 rounded px-1.5 text-xs",
                  step.variant ? "bg-primary/10 text-primary" : "bg-muted",
                )}
              >
                {step.variant
                  ? `variant of ${steps.filter((s, i) => !s.variant && i < index).length}`
                  : steps.filter((s, i) => !s.variant && i <= index).length}
              </span>

              <button
                type="button"
                onClick={() => setOpen(open === step.key ? null : step.key)}
                className="min-w-0 flex-1 truncate text-left text-sm hover:underline"
              >
                {step.email_subject || (
                  <em className="text-muted-foreground">Untitled step</em>
                )}
              </button>

              {isNew ? (
                <span className="shrink-0 rounded bg-emerald-100 px-1.5 text-[11px] text-emerald-800">
                  new
                </span>
              ) : null}
              {variations > 1 ? (
                <span className="tnum shrink-0 rounded border px-1 text-[11px] text-muted-foreground">
                  {variations} variations
                </span>
              ) : null}

              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  aria-label="Move step up"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
                >
                  <ChevronUp className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="Move step down"
                  disabled={index === steps.length - 1}
                  onClick={() => move(index, 1)}
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
                >
                  <ChevronDown className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="Remove step"
                  disabled={locked}
                  onClick={() => remove(index)}
                  // The tooltip is the whole explanation: EmailBison refuses to
                  // delete a step that has sent, so the button can't work.
                  title={
                    locked
                      ? "This step has already sent emails — EmailBison will not delete it"
                      : "Remove this step"
                  }
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-red-700 disabled:opacity-30"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </div>

            {open === step.key ? (
              <div className="space-y-3 p-3">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-[240px] flex-1 space-y-1">
                    <label className="text-[11px] font-medium">Subject</label>
                    <Input
                      value={step.email_subject}
                      onChange={(e) => update(index, { email_subject: e.target.value })}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="w-28 space-y-1">
                    {/*
                      EmailBison's own wording: wait_in_days is "how many days
                      before the sequence moves to the NEXT step" — a delay
                      AFTER this email, not before it. The first email goes out
                      as soon as the lead enters, so labelling this "Wait"
                      beside step 1 read as a delay before anything was sent.
                      The last step's value has nothing to gate and is inert.
                    */}
                    <label className="text-[11px] font-medium">
                      {index === steps.length - 1 ? "Wait (unused)" : "Then wait (days)"}
                    </label>
                    <Input
                      type="number"
                      min={0}
                      value={step.wait_in_days}
                      onChange={(e) =>
                        update(index, { wait_in_days: Number(e.target.value) || 0 })
                      }
                      className="tnum h-8 text-xs"
                    />
                  </div>
                  <label className="flex h-8 cursor-pointer items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={step.thread_reply}
                      onChange={(e) => update(index, { thread_reply: e.target.checked })}
                      className="size-3.5 accent-foreground"
                    />
                    <span className="text-[11px]">Reply in thread</span>
                  </label>
                </div>

                {step.thread_reply ? (
                  // Otherwise the saved subject differs from what was typed and
                  // looks like the edit failed.
                  <p className="text-[11px] text-muted-foreground">
                    EmailBison adds the &ldquo;Re: &rdquo; prefix to threaded steps — don&apos;t
                    type it.
                  </p>
                ) : null}

                <div className="space-y-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="text-[11px] font-medium">Body</label>

                    <div className="flex items-center gap-1">
                      {/*
                        §9.3: "Write the email with formatting." Wraps the
                        selection in HTML rather than editing rendered output —
                        the body carries spintax and merge tags in single braces
                        that a contenteditable surface would rewrite.
                      */}
                      <div className="flex items-center rounded-md border">
                        {FORMATS.map((f) => (
                          <button
                            key={f.title}
                            type="button"
                            title={f.title}
                            aria-label={f.title}
                            onClick={() => wrap(index, f.open, f.close)}
                            className={cn(
                              "h-6 w-6 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground",
                              f.className,
                            )}
                          >
                            {f.label}
                          </button>
                        ))}
                      </div>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="outline" size="sm" className="h-6 text-[11px]">
                            Insert field
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
                          {tags.map((tag) => (
                            <DropdownMenuItem
                              key={tag}
                              onSelect={() => insertTag(index, tag)}
                              className="font-mono text-xs"
                            >
                              {tag}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                  <textarea
                    ref={(el) => {
                      bodyRefs.current[step.key] = el;
                    }}
                    value={step.email_body}
                    onChange={(e) => update(index, { email_body: e.target.value })}
                    rows={10}
                    spellCheck
                    className="w-full rounded-md border bg-background p-2 font-mono text-xs leading-relaxed"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    HTML and spintax (<code>{"{a|b}"}</code>) are both preserved as typed.
                  </p>
                </div>

                <div>
                  <p className="mb-1 text-[11px] font-medium">Preview</p>
                  <EmailPanel subject={step.email_subject} body={step.email_body} />
                </div>

                {/* §6.3: "Tag the copy's seven dimensions from the same screen." */}
                <div className="border-t pt-3">
                  <CopyTagsPanel
                    stepId={step.id ?? null}
                    isFirstEmail={index === 0 || step.variant}
                  />
                </div>
              </div>
            ) : null}
          </div>
        );
      })}

      <Button variant="outline" size="sm" onClick={add} className="h-8 gap-1.5 text-xs">
        <Plus className="size-3.5" />
        Add step
      </Button>

      {steps.some((s) => s.id != null && sent.has(s.id)) ? (
        <p className="flex items-start gap-2 text-[11px] text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          Steps that have already sent emails cannot be removed — EmailBison refuses to delete
          them. They can still be edited and reordered.
        </p>
      ) : null}
    </div>
  );
}
