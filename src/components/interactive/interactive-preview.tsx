"use client";

import { List, Reply, ShoppingBag } from "lucide-react";
import { cn } from "@/lib/utils";
import type { InteractiveMessagePayload } from "@/lib/whatsapp/interactive";

/**
 * WhatsApp-style read-only render of an interactive message. Used both
 * in the builder's live preview and by the inbox message bubble so a
 * sent buttons/list/product message shows approximately the way it
 * does on the phone.
 *
 * Purely presentational — the buttons/rows are not clickable here (the
 * customer taps them on their own device). Kept namespace-free (plain
 * English) so it can be dropped into the composer, the automation
 * builder, and the quick-replies manager without namespace coupling.
 *
 * Product cards are the one approximation: Meta renders the photo/
 * name/price itself from the live catalog at delivery time, and this
 * component only has the persisted `catalog_id`/`product_retailer_id`
 * (no name/price lookup) — so it shows a generic placeholder rather
 * than the real card. Good enough for "yes, a product was sent here."
 */
export function InteractivePreview({
  payload,
  className,
}: {
  payload: InteractiveMessagePayload;
  className?: string;
}) {
  // `header`/`body`/`footer`/`button_label` aren't shared by every kind
  // (a single product card has no header, and only `list` has a button
  // label) — narrow to a loose shape once here rather than accessing
  // fields TypeScript can't guarantee exist on all four payload kinds.
  const header = payload.kind === "buttons" || payload.kind === "list" || payload.kind === "product_list"
    ? payload.header
    : undefined;
  const body = payload.body;
  const footer = payload.footer;

  return (
    <div
      className={cn(
        "w-full max-w-[260px] overflow-hidden rounded-lg bg-card text-foreground shadow-sm ring-1 ring-border",
        className,
      )}
    >
      <div className="px-3 py-2">
        {header ? (
          <p className="mb-1 break-words text-sm font-semibold">{header}</p>
        ) : null}
        <p className="whitespace-pre-wrap break-words text-sm">
          {body || <span className="text-muted-foreground">Message body…</span>}
        </p>
        {footer ? (
          <p className="mt-1 break-words text-[11px] text-muted-foreground">
            {footer}
          </p>
        ) : null}
      </div>

      {payload.kind === "buttons" ? (
        <div className="flex flex-col border-t border-border">
          {payload.buttons.map((b, i) => (
            <button
              key={b.id || i}
              type="button"
              disabled
              className="flex items-center justify-center gap-1.5 border-t border-border py-2 text-sm font-medium text-primary first:border-t-0"
            >
              <Reply className="h-3.5 w-3.5" />
              <span className="truncate">{b.title || "Button"}</span>
            </button>
          ))}
        </div>
      ) : payload.kind === "list" ? (
        <button
          type="button"
          disabled
          className="flex w-full items-center justify-center gap-1.5 border-t border-border py-2 text-sm font-medium text-primary"
        >
          <List className="h-3.5 w-3.5" />
          <span className="truncate">{payload.button_label || "Menu"}</span>
        </button>
      ) : payload.kind === "product" ? (
        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
            <ShoppingBag className="h-4 w-4 text-muted-foreground" />
          </span>
          <span className="truncate text-xs text-muted-foreground">
            Product · {payload.product_retailer_id}
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-1 border-t border-border px-3 py-2">
          {payload.sections.map((s, i) => (
            <div key={i} className="text-xs text-muted-foreground">
              {s.title ? <p className="font-medium text-foreground">{s.title}</p> : null}
              <p className="flex items-center gap-1.5">
                <ShoppingBag className="h-3.5 w-3.5 shrink-0" />
                {s.product_retailer_ids.length} product
                {s.product_retailer_ids.length === 1 ? "" : "s"}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
