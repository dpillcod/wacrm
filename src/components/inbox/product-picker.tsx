"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { CatalogProduct } from "@/types";
import type { InteractiveProductPayload } from "@/lib/whatsapp/interactive";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ArrowLeft, ChevronRight, Loader2, ShoppingBag } from "lucide-react";
import { useTranslations } from "next-intl";

interface ProductPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (payload: InteractiveProductPayload) => void;
}

/**
 * Pick a product synced from the account's connected Meta Commerce
 * Catalog and send it as a native WhatsApp product card. Mirrors
 * template-picker.tsx's shape (list → optional details → confirm),
 * simplified since a product card needs no required variables — just
 * an optional caption.
 */
export function ProductPicker({ open, onOpenChange, onSelect }: ProductPickerProps) {
  const t = useTranslations("Inbox.productPicker");

  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [catalogId, setCatalogId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<CatalogProduct | null>(null);
  const [caption, setCaption] = useState("");

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    (async () => {
      setLoading(true);
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        if (!cancelled) {
          setProducts([]);
          setCatalogId(null);
          setLoading(false);
        }
        return;
      }

      const { data: profile } = await supabase
        .from("profiles")
        .select("account_id")
        .eq("user_id", user.id)
        .maybeSingle();
      const accountId = profile?.account_id as string | undefined;

      const [{ data: config }, { data: rows, error }] = await Promise.all([
        accountId
          ? supabase
              .from("whatsapp_config")
              .select("catalog_id")
              .eq("account_id", accountId)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        accountId
          ? supabase
              .from("catalog_products")
              .select("*")
              .eq("account_id", accountId)
              .eq("is_stale", false)
              .order("name", { ascending: true })
          : Promise.resolve({ data: [], error: null }),
      ]);

      if (cancelled) return;
      if (error) {
        console.error("Failed to fetch catalog products:", error);
        setProducts([]);
      } else {
        setProducts((rows as CatalogProduct[]) ?? []);
      }
      setCatalogId(config?.catalog_id ?? null);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  function resetSelection() {
    setSelected(null);
    setCaption("");
  }

  function handleOpenChange(next: boolean) {
    if (!next) resetSelection();
    onOpenChange(next);
  }

  function confirm() {
    if (!selected || !catalogId) return;
    const payload: InteractiveProductPayload = {
      kind: "product",
      catalog_id: catalogId,
      product_retailer_id: selected.retailer_id,
      body: caption.trim() || undefined,
    };
    onSelect(payload);
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <ShoppingBag className="h-4 w-4 text-primary" />
            {selected ? selected.name : t("sendProduct")}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {selected ? t("addCaption") : t("pickProduct")}
          </DialogDescription>
        </DialogHeader>

        {!selected ? (
          <div className="max-h-[60vh] space-y-2 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              </div>
            ) : !catalogId ? (
              <div className="rounded-md border border-border bg-background/50 p-6 text-center">
                <p className="text-sm text-popover-foreground">{t("noCatalog")}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("noCatalogHint")}
                </p>
              </div>
            ) : products.length === 0 ? (
              <div className="rounded-md border border-border bg-background/50 p-6 text-center">
                <p className="text-sm text-popover-foreground">{t("noProducts")}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("noProductsHint")}
                </p>
              </div>
            ) : (
              products.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelected(p)}
                  className="w-full rounded-md border border-border bg-background/50 p-3 text-left transition-colors hover:border-primary/40 hover:bg-popover"
                >
                  <div className="flex items-center gap-3">
                    {p.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={p.image_url}
                        alt={p.name}
                        className="size-10 shrink-0 rounded-md border border-border object-cover"
                      />
                    ) : (
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
                        <ShoppingBag className="size-4 text-muted-foreground" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-popover-foreground">
                        {p.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {p.price != null
                          ? `${p.price}${p.currency ? ` ${p.currency}` : ""}`
                          : p.retailer_id}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  </div>
                </button>
              ))
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs text-popover-foreground">
                {t("caption")}
              </Label>
              <Input
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder={t("captionPlaceholder")}
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
              />
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          {selected ? (
            <>
              <Button
                variant="outline"
                onClick={resetSelection}
                className="border-border text-popover-foreground hover:bg-muted"
              >
                <ArrowLeft className="h-4 w-4" />
                {t("back")}
              </Button>
              <Button
                onClick={confirm}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {t("send")}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
              className="border-border text-popover-foreground hover:bg-muted"
            >
              {t("cancel")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
