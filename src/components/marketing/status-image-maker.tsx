"use client";

import { useEffect, useRef, useState } from "react";
import { Copy, Download, ImagePlus, Loader2, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AdLinkRow } from "./ad-links-panel";

interface Product {
  sku: string;
  title: string;
  price: number;
  salePrice: number | null;
  thumb: string | null;
  image: string | null;
}

const W = 1080;
const H = 1920;
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";

const THEMES = {
  yellow: { bg: "#111111", accent: "#facc15", text: "#ffffff", onAccent: "#111111" },
  red: { bg: "#b91c1c", accent: "#ffffff", text: "#ffffff", onAccent: "#b91c1c" },
  green: { bg: "#14532d", accent: "#4ade80", text: "#ffffff", onAccent: "#052e16" },
  white: { bg: "#ffffff", accent: "#111111", text: "#111111", onAccent: "#ffffff" },
} as const;
type ThemeKey = keyof typeof THEMES;

const money = (n: number) =>
  `$${n.toFixed(2).replace(".", ",")}`;

/** "593993679794" + "593" → "099 367 9794". */
function localPhone(number: string, cc: string): string {
  const local = cc && number.startsWith(cc) ? `0${number.slice(cc.length)}` : number;
  return local.length === 10 ? `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}` : local;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width <= maxWidth || !line) line = next;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].replace(/\s+\S*$/, "")}…`;
    return kept;
  }
  return lines;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

/**
 * A vertical image (1080×1920) for a WhatsApp Status or Instagram story:
 * a product of the web shop (photo + price) or an uploaded photo, the
 * business name and how to order. Drawn on a canvas, downloaded as PNG.
 */
export function StatusImageMaker({
  links,
  businessName,
  whatsappNumber,
  countryCode,
}: {
  links: AdLinkRow[];
  businessName: string;
  whatsappNumber: string;
  countryCode: string;
}) {
  const t = useTranslations("Marketing.image");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Product[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [photo, setPhoto] = useState<HTMLImageElement | null>(null);
  const [loadingPhoto, setLoadingPhoto] = useState(false);
  const [badge, setBadge] = useState(t("badgeDefault"));
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("");
  const [oldPrice, setOldPrice] = useState("");
  const [footer, setFooter] = useState(t("footerDefault"));
  const [theme, setTheme] = useState<ThemeKey>("yellow");
  const [linkCode, setLinkCode] = useState("");

  const phone = whatsappNumber ? localPhone(whatsappNumber, countryCode) : "";

  async function search() {
    setSearching(true);
    try {
      const res = await fetch(`/api/marketing/products?q=${encodeURIComponent(query)}`);
      const json = (await res.json()) as { items?: Product[] };
      setResults(json.items ?? []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  function loadImage(src: string) {
    setLoadingPhoto(true);
    const img = new Image();
    img.onload = () => {
      setPhoto(img);
      setLoadingPhoto(false);
    };
    img.onerror = () => {
      setPhoto(null);
      setLoadingPhoto(false);
      toast.error(t("photoFailed"));
    };
    img.src = src;
  }

  function pick(p: Product) {
    setTitle(p.title);
    if (p.salePrice !== null && p.salePrice < p.price) {
      setPrice(money(p.salePrice));
      setOldPrice(money(p.price));
    } else {
      setPrice(money(p.price));
      setOldPrice("");
    }
    if (p.image) loadImage(`/api/marketing/image?url=${encodeURIComponent(p.image)}`);
    else setPhoto(null);
  }

  function upload(file: File | undefined) {
    if (!file || !file.type.startsWith("image/")) return;
    loadImage(URL.createObjectURL(file));
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const c = THEMES[theme];
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Business name
    ctx.fillStyle = c.text;
    ctx.font = `800 72px ${FONT}`;
    ctx.fillText((businessName || "").toUpperCase(), W / 2, 150, W - 120);

    // Badge
    if (badge.trim()) {
      ctx.font = `800 60px ${FONT}`;
      const bw = Math.min(W - 160, ctx.measureText(badge.toUpperCase()).width + 100);
      ctx.fillStyle = c.accent;
      roundRect(ctx, (W - bw) / 2, 225, bw, 100, 50);
      ctx.fillStyle = c.onAccent;
      ctx.fillText(badge.toUpperCase(), W / 2, 277, bw - 60);
    }

    // Photo card
    const card = { x: 90, y: 370, w: 900, h: 860 };
    ctx.fillStyle = "#ffffff";
    roundRect(ctx, card.x, card.y, card.w, card.h, 48);
    if (photo) {
      const pad = 40;
      const scale = Math.min((card.w - pad * 2) / photo.width, (card.h - pad * 2) / photo.height);
      const pw = photo.width * scale;
      const ph = photo.height * scale;
      ctx.drawImage(photo, card.x + (card.w - pw) / 2, card.y + (card.h - ph) / 2, pw, ph);
    } else {
      ctx.fillStyle = "#9ca3af";
      ctx.font = `600 44px ${FONT}`;
      ctx.fillText(t("noPhoto"), W / 2, card.y + card.h / 2, card.w - 80);
    }

    // Product name
    ctx.fillStyle = c.text;
    ctx.font = `800 66px ${FONT}`;
    const lines = wrap(ctx, title.trim(), W - 140, 3);
    lines.forEach((l, i) => ctx.fillText(l, W / 2, 1320 + i * 78));
    let y = 1320 + Math.max(lines.length, 1) * 78 + 20;

    // Price (and the old one, struck through)
    if (oldPrice.trim()) {
      ctx.font = `600 58px ${FONT}`;
      ctx.fillStyle = c.text;
      ctx.globalAlpha = 0.7;
      ctx.fillText(oldPrice, W / 2, y + 10);
      const ow = ctx.measureText(oldPrice).width;
      ctx.fillRect(W / 2 - ow / 2 - 6, y + 8, ow + 12, 6);
      ctx.globalAlpha = 1;
      y += 70;
    }
    if (price.trim()) {
      ctx.font = `900 150px ${FONT}`;
      ctx.fillStyle = c.accent;
      ctx.fillText(price, W / 2, y + 85, W - 120);
    }

    // How to order
    ctx.fillStyle = c.accent;
    roundRect(ctx, 70, 1730, W - 140, 130, 65);
    ctx.fillStyle = c.onAccent;
    ctx.font = `800 50px ${FONT}`;
    ctx.fillText(`${footer.trim()}${phone ? `  ${phone}` : ""}`, W / 2, 1797, W - 200);
  }, [theme, businessName, badge, photo, title, price, oldPrice, footer, phone, t]);

  function download() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `estado-${(title || "publicidad").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5_000);
    }, "image/png");
  }

  const link = links.find((l) => l.code === linkCode);
  const caption = [title.trim() && `🛒 ${title.trim()}${price.trim() ? ` a ${price.trim()}` : ""}`, link?.url && `👉 ${t("orderHere")} ${link.url}`]
    .filter(Boolean)
    .join("\n");

  async function copyCaption() {
    try {
      await navigator.clipboard.writeText(caption);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  }

  return (
    <section className="grid gap-4 rounded-lg border border-border bg-card p-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("desc")}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid content-start gap-3">
          <div className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void search()}
              placeholder={t("searchPlaceholder")}
            />
            <Button type="button" variant="secondary" onClick={() => void search()} disabled={searching}>
              {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            </Button>
            <label className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-border px-2.5 text-sm hover:bg-muted">
              <ImagePlus className="h-4 w-4" />
              <span className="hidden sm:inline">{t("upload")}</span>
              <input type="file" accept="image/*" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
            </label>
          </div>

          {results && (
            results.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noResults")}</p>
            ) : (
              <ul className="grid max-h-64 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
                {results.map((p) => (
                  <li key={p.sku}>
                    <button
                      type="button"
                      onClick={() => pick(p)}
                      className="grid w-full gap-1 rounded-md border border-border p-2 text-left text-xs hover:bg-muted"
                    >
                      {p.thumb ? (
                        // eslint-disable-next-line @next/next/no-img-element -- remote shop thumbnails
                        <img src={p.thumb} alt="" className="h-20 w-full object-contain" loading="lazy" />
                      ) : (
                        <div className="flex h-20 items-center justify-center bg-muted text-muted-foreground">{t("noPhotoShort")}</div>
                      )}
                      <span className="line-clamp-2 text-foreground">{p.title}</span>
                      <span className="font-semibold">{money(p.salePrice ?? p.price)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm sm:col-span-2">
              <span className="font-medium">{t("productName")}</span>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={90} />
              <span className="text-xs text-muted-foreground">{t("productNameHint")}</span>
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">{t("price")}</span>
              <Input value={price} onChange={(e) => setPrice(e.target.value)} maxLength={20} />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">{t("oldPrice")}</span>
              <Input value={oldPrice} onChange={(e) => setOldPrice(e.target.value)} maxLength={20} />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">{t("badge")}</span>
              <Input value={badge} onChange={(e) => setBadge(e.target.value)} maxLength={24} />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">{t("theme")}</span>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={theme}
                onChange={(e) => setTheme(e.target.value as ThemeKey)}
              >
                {(Object.keys(THEMES) as ThemeKey[]).map((k) => (
                  <option key={k} value={k}>
                    {t(`themes.${k}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm sm:col-span-2">
              <span className="font-medium">{t("footer")}</span>
              <Input value={footer} onChange={(e) => setFooter(e.target.value)} maxLength={40} />
            </label>
          </div>

          <div className="grid gap-2 rounded-md border border-border p-3">
            <label className="grid gap-1 text-sm">
              <span className="font-medium">{t("captionLink")}</span>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={linkCode}
                onChange={(e) => setLinkCode(e.target.value)}
              >
                <option value="">{t("noLink")}</option>
                {links.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name} (#{l.code})
                  </option>
                ))}
              </select>
            </label>
            <pre className="whitespace-pre-wrap break-all rounded bg-muted px-2 py-1 text-xs text-foreground/80">
              {caption || t("captionEmpty")}
            </pre>
            <div>
              <Button type="button" size="sm" variant="secondary" onClick={() => void copyCaption()} disabled={!caption}>
                <Copy className="mr-1 h-3.5 w-3.5" />
                {t("copyCaption")}
              </Button>
            </div>
          </div>
        </div>

        <div className="grid content-start gap-2">
          <div className="relative">
            <canvas
              ref={canvasRef}
              width={W}
              height={H}
              className="h-auto w-full rounded-lg border border-border shadow-sm"
            />
            {loadingPhoto && (
              <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/60">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            )}
          </div>
          <Button type="button" onClick={download}>
            <Download className="mr-1 h-4 w-4" />
            {t("download")}
          </Button>
          <p className="text-xs text-muted-foreground">{t("howTo")}</p>
        </div>
      </div>
    </section>
  );
}
