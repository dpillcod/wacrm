"use client";

import { useEffect, useState } from "react";
import { Library, Loader2, Search } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/** A finished piece from the media library (GET /api/media-library). */
export interface LibraryPiece {
  id: string;
  source: string;
  ref: string | null;
  name: string;
  caption: string | null;
  tags: string[];
  url: string;
  mime_type: string;
  valid_until: string | null;
  updated_at: string;
}

interface MediaLibraryPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (piece: LibraryPiece) => void;
}

/**
 * The pieces a design app left ready to send (POST /api/v1/media), as a
 * grid of thumbnails. Picking one hands it to the caller — the inbox
 * stages it with its suggested caption, the broadcast wizard uses it as
 * the header image. No download, no re-upload: the CRM already has it.
 */
export function MediaLibraryPicker({ open, onOpenChange, onPick }: MediaLibraryPickerProps) {
  const t = useTranslations("MediaLibrary");
  const [items, setItems] = useState<LibraryPiece[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/media-library", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok) setItems((data.items as LibraryPiece[]) ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const shown = q
    ? items.filter((p) =>
        [p.name, p.caption ?? "", p.ref ?? "", ...p.tags].some((s) => s.toLowerCase().includes(q)),
      )
    : items;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Library className="h-4 w-4" />
            {t("title")}
          </DialogTitle>
        </DialogHeader>
        {items.length > 6 && (
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("search")}
              className="pl-8"
            />
          </div>
        )}
        <div className="max-h-[60vh] overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : shown.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {items.length === 0 ? t("empty") : t("noMatch")}
            </p>
          ) : (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {shown.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => onPick(p)}
                    className="flex w-full flex-col overflow-hidden rounded-md border border-border bg-muted/40 text-left hover:border-primary/50 hover:bg-muted"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- a public piece in our own bucket */}
                    <img src={p.url} alt={p.name} loading="lazy" className="aspect-square w-full bg-muted object-cover" />
                    <span className="flex flex-col gap-0.5 p-2">
                      <span className="line-clamp-2 text-xs font-medium text-foreground">{p.name}</span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {p.source}
                        {p.valid_until ? ` · ${t("until", { date: p.valid_until })}` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
