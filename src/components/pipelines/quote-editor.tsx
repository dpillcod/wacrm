"use client";

import { useEffect, useState } from "react";
import { FileText, Loader2, Plus, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { lineTotal, quoteMoney, quoteTotals, type Quote, type QuoteItem } from "@/lib/pipelines/quote";

/**
 * "Cotización" on an order card: a person writes the prices of the
 * customer's list (prefilled from the card) and the CRM sends a PDF with
 * the store's details and [✅ Acepto] [✏️ Cambiar algo] in the chat.
 * The bot itself never quotes prices. See app/api/pipelines/deals/[id]/quote.
 */

interface Row {
  qty: string;
  description: string;
  unitPrice: string;
}

const toRow = (i: QuoteItem): Row => ({
  qty: String(i.qty),
  description: i.description,
  unitPrice: i.unitPrice ? String(i.unitPrice) : "",
});
const num = (s: string) => {
  const n = Number(String(s).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};
const toItem = (r: Row): QuoteItem => ({ qty: num(r.qty), description: r.description.trim(), unitPrice: num(r.unitPrice) });

export function QuoteEditor({
  dealId,
  onSent,
  onTotal,
}: {
  dealId: string;
  /** The quote went out: the card changed on the server (value, notes, column). */
  onSent: () => void;
  /** Saved: the card's value is now this total (keeps the form in step). */
  onTotal: (total: number) => void;
}) {
  const t = useTranslations("Pipelines.quote");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "pdf" | "send">(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [windowOpen, setWindowOpen] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);
  const [delivery, setDelivery] = useState("");
  const [validDays, setValidDays] = useState("3");
  const [notes, setNotes] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerId, setCustomerId] = useState("");

  useEffect(() => {
    if (!open || quote) return;
    let cancelled = false;
    fetch(`/api/pipelines/deals/${dealId}/quote`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { quote: Quote; windowOpen: boolean }) => {
        if (cancelled) return;
        const q = body.quote;
        setQuote(q);
        setWindowOpen(body.windowOpen);
        setRows(q.items.length ? q.items.map(toRow) : [{ qty: "1", description: "", unitPrice: "" }]);
        setDelivery(q.delivery ? String(q.delivery) : "");
        setValidDays(String(q.validDays));
        setNotes(q.notes);
        setCustomerName(q.customerName);
        setCustomerId(q.customerId);
      })
      .catch(() => {
        if (!cancelled) toast.error(t("loadFailed"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, quote, dealId, t]);

  const items = rows.map(toItem).filter((i) => i.description && i.qty > 0);
  const totals = quoteTotals({ items, delivery: num(delivery) });
  const missingPrices = items.some((i) => !i.unitPrice);
  const setRow = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function submit(action: "save" | "pdf" | "send") {
    if (!items.length) {
      toast.error(t("noItems"));
      return;
    }
    // Opened right away (inside the click) so the browser doesn't block the tab.
    const pdfTab = action === "pdf" ? window.open("", "_blank") : null;
    setBusy(action);
    try {
      const res = await fetch(`/api/pipelines/deals/${dealId}/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, items, delivery: num(delivery), validDays: num(validDays), notes, customerName, customerId }),
      });
      if (!res.ok) throw new Error(String(res.status));
      if (action === "pdf") {
        onTotal(totals.total);
        const url = URL.createObjectURL(await res.blob());
        if (pdfTab) pdfTab.location.href = url;
        else window.open(url, "_blank");
        return;
      }
      const body = (await res.json()) as { quote?: Quote; sent?: boolean; reason?: string };
      if (action === "save") {
        if (body.quote) setQuote(body.quote);
        onTotal(totals.total);
        toast.success(t("saved"));
        return;
      }
      if (body.sent) {
        toast.success(t("sent"));
        setQuote(null);
        setOpen(false);
        onSent();
      } else if (body.reason === "window_closed") toast.warning(t("windowClosed"));
      else if (body.reason === "missing_prices") toast.error(t("missingPrices"));
      else if (body.reason === "no_conversation") toast.error(t("noConversation"));
      else toast.error(t("sendFailed"));
    } catch {
      pdfTab?.close();
      toast.error(t("sendFailed"));
    } finally {
      setBusy(null);
    }
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={() => {
          setLoading(!quote);
          setOpen(true);
        }}
      >
        <FileText className="mr-1.5 h-4 w-4" />
        {t("open")}
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">
          {t("title")} {quote ? <span className="text-muted-foreground">· {quote.number}</span> : null}
        </p>
        {quote?.status && quote.status !== "draft" && (
          <span className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">{t(`status.${quote.status}`)}</span>
        )}
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("loading")}
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{t("hint")}</p>
          <div className="space-y-2">
            <div className="grid grid-cols-[56px_1fr_84px_28px] gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
              <span>{t("qty")}</span>
              <span>{t("description")}</span>
              <span>{t("unitPrice")}</span>
              <span />
            </div>
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[56px_1fr_84px_28px] items-center gap-1.5">
                <Input value={r.qty} inputMode="decimal" onChange={(e) => setRow(i, { qty: e.target.value })} className="h-8 px-2" />
                <Input value={r.description} onChange={(e) => setRow(i, { description: e.target.value })} className="h-8 px-2" />
                <Input
                  value={r.unitPrice}
                  inputMode="decimal"
                  placeholder="$"
                  onChange={(e) => setRow(i, { unitPrice: e.target.value })}
                  className={`h-8 px-2 ${toItem(r).description && !toItem(r).unitPrice ? "border-amber-500" : ""}`}
                />
                <button
                  type="button"
                  aria-label={t("remove")}
                  onClick={() => setRows(rows.filter((_, j) => j !== i))}
                  className="flex h-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
                {toItem(r).unitPrice > 0 && toItem(r).qty !== 1 && (
                  <span className="col-span-4 -mt-1 text-right text-[11px] text-muted-foreground">
                    = {quoteMoney(lineTotal(toItem(r)))}
                  </span>
                )}
              </div>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setRows([...rows, { qty: "1", description: "", unitPrice: "" }])}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t("addRow")}
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1">
              <Label className="text-xs text-muted-foreground">{t("delivery")}</Label>
              <Input value={delivery} inputMode="decimal" placeholder="0" onChange={(e) => setDelivery(e.target.value)} className="h-8" />
            </div>
            <div className="grid gap-1">
              <Label className="text-xs text-muted-foreground">{t("validDays")}</Label>
              <Input value={validDays} inputMode="numeric" onChange={(e) => setValidDays(e.target.value)} className="h-8" />
            </div>
            <div className="grid gap-1">
              <Label className="text-xs text-muted-foreground">{t("customerName")}</Label>
              <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} className="h-8" />
            </div>
            <div className="grid gap-1">
              <Label className="text-xs text-muted-foreground">{t("customerId")}</Label>
              <Input value={customerId} onChange={(e) => setCustomerId(e.target.value)} className="h-8" />
            </div>
          </div>
          <div className="grid gap-1">
            <Label className="text-xs text-muted-foreground">{t("notes")}</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder={t("notesPlaceholder")} />
          </div>

          <div className="flex items-baseline justify-between border-t border-border pt-2">
            <span className="text-sm text-muted-foreground">{t("total")}</span>
            <span className="text-lg font-semibold text-foreground">{quoteMoney(totals.total)}</span>
          </div>
          {missingPrices && <p className="text-xs text-amber-500">{t("missingPrices")}</p>}
          {!windowOpen && <p className="text-xs text-amber-500">{t("windowClosed")}</p>}

          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={!!busy} onClick={() => submit("pdf")}>
              {busy === "pdf" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="mr-1 h-4 w-4" />}
              {t("viewPdf")}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={!!busy} onClick={() => submit("save")}>
              {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : t("save")}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!!busy || missingPrices || !windowOpen}
              onClick={() => submit("send")}
              className="ml-auto bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {busy === "send" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="mr-1 h-4 w-4" />}
              {t("send")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
