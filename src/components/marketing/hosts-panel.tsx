"use client";

import { useState } from "react";
import QRCode from "qrcode";
import { Copy, Download, Loader2, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface HostProgram {
  discountPct: number;
  freeDeliveryFrom: number;
  validDays: number;
  welcomeText: string;
}

interface Totals {
  scans: number;
  guests: number;
  orders: number;
  sales: number;
}

export interface HostRow {
  code: string;
  name: string;
  createdAt: string;
  host: { lodging: string; phone: string; reward: string };
  scanUrl: string;
  all: Totals;
  month: Totals;
  countries: { country: string; count: number }[];
  lastOrderAt: string | null;
  summary: string;
}

const money = (n: number) => `$${n.toFixed(2).replace(".", ",")}`;

/** A printable card: the offer, the QR, the apartment's name. */
async function downloadQrCard(host: HostRow, businessName: string, discountPct: number) {
  const W = 1200;
  const H = 1650;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#111111";
  ctx.textAlign = "center";
  ctx.font = "bold 72px system-ui, sans-serif";
  ctx.fillText(businessName || "", W / 2, 140);
  if (discountPct > 0) {
    ctx.font = "bold 96px system-ui, sans-serif";
    ctx.fillText(`${discountPct} % de descuento`, W / 2, 270);
    ctx.font = "48px system-ui, sans-serif";
    ctx.fillText(`${discountPct}% off for our guests`, W / 2, 340);
  }
  const qr = document.createElement("canvas");
  await QRCode.toCanvas(qr, host.scanUrl, { width: 860, margin: 1, errorCorrectionLevel: "M" });
  ctx.drawImage(qr, (W - 860) / 2, 400, 860, 860);
  ctx.font = "bold 50px system-ui, sans-serif";
  ctx.fillText("Escanee y escríbanos por WhatsApp", W / 2, 1360);
  ctx.font = "42px system-ui, sans-serif";
  ctx.fillText("Scan and message us on WhatsApp", W / 2, 1425);
  ctx.fillStyle = "#555555";
  ctx.font = "38px system-ui, sans-serif";
  ctx.fillText(`${host.host.lodging || host.name} · #${host.code}`, W / 2, 1540);
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = `qr-${host.code.toLowerCase()}.png`;
  a.click();
}

/**
 * Airbnb hosts: a QR per host for their apartment. Guests who write
 * through it get the program's discount; the ranking shows which host
 * brings the most sales.
 */
export function HostsPanel({
  program: initialProgram,
  hosts,
  hasNumber,
  businessName,
  month,
  onChanged,
}: {
  program: HostProgram;
  hosts: HostRow[];
  hasNumber: boolean;
  businessName: string;
  month: string;
  onChanged: () => void;
}) {
  const t = useTranslations("Marketing.hosts");
  const [program, setProgram] = useState<HostProgram>(initialProgram);
  const [savingProgram, setSavingProgram] = useState(false);
  const [form, setForm] = useState({ name: "", lodging: "", phone: "", reward: "", code: "" });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState({ name: "", lodging: "", phone: "", reward: "" });

  async function saveProgram() {
    setSavingProgram(true);
    try {
      const res = await fetch("/api/marketing/hosts", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ program }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setProgram(((await res.json()) as { program: HostProgram }).program);
      toast.success(t("saved"));
      onChanged();
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setSavingProgram(false);
    }
  }

  async function create() {
    if (!form.name.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/marketing/hosts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      if (res.status === 409) {
        toast.error(t("codeTaken"));
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      setForm({ name: "", lodging: "", phone: "", reward: "", code: "" });
      toast.success(t("created"));
      onChanged();
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setCreating(false);
    }
  }

  async function saveEdit(code: string) {
    const res = await fetch("/api/marketing/hosts", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, ...edit }),
    });
    if (!res.ok) {
      toast.error(t("saveFailed"));
      return;
    }
    setEditing(null);
    toast.success(t("saved"));
    onChanged();
  }

  async function remove(host: HostRow) {
    if (!window.confirm(t("confirmDelete", { name: host.name }))) return;
    const res = await fetch(`/api/marketing/links?code=${encodeURIComponent(host.code)}`, { method: "DELETE" });
    if (res.ok) onChanged();
    else toast.error(t("saveFailed"));
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  }

  const num = (v: string) => (v.trim() === "" ? 0 : Number(v.replace(",", ".")));

  return (
    <section className="grid gap-5 rounded-lg border border-border bg-card p-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("desc")}</p>
      </div>

      {!hasNumber && (
        <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          {t("noNumber")}
        </p>
      )}

      {/* Program */}
      <div className="grid gap-3 rounded-md border border-border p-3">
        <h3 className="text-sm font-semibold text-foreground">{t("programTitle")}</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="grid gap-1 text-sm">
            <span className="font-medium">{t("discount")}</span>
            <Input
              inputMode="decimal"
              value={String(program.discountPct)}
              onChange={(e) => setProgram({ ...program, discountPct: num(e.target.value) || 0 })}
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">{t("freeDelivery")}</span>
            <Input
              inputMode="decimal"
              value={String(program.freeDeliveryFrom)}
              onChange={(e) => setProgram({ ...program, freeDeliveryFrom: num(e.target.value) || 0 })}
            />
            <span className="text-xs text-muted-foreground">{t("freeDeliveryHint")}</span>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">{t("validDays")}</span>
            <Input
              inputMode="numeric"
              value={String(program.validDays)}
              onChange={(e) => setProgram({ ...program, validDays: num(e.target.value) || 1 })}
            />
          </label>
          <label className="grid gap-1 text-sm sm:col-span-3">
            <span className="font-medium">{t("welcome")}</span>
            <textarea
              className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={program.welcomeText}
              maxLength={1000}
              onChange={(e) => setProgram({ ...program, welcomeText: e.target.value })}
            />
            <span className="text-xs text-muted-foreground">{t.raw("welcomeHint") as string}</span>
          </label>
        </div>
        <div>
          <Button type="button" variant="secondary" onClick={() => void saveProgram()} disabled={savingProgram}>
            {savingProgram ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
            {t("saveProgram")}
          </Button>
        </div>
      </div>

      {/* New host */}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          <span className="font-medium">{t("name")}</span>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("namePlaceholder")} maxLength={80} />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">{t("lodging")}</span>
          <Input value={form.lodging} onChange={(e) => setForm({ ...form, lodging: e.target.value })} placeholder={t("lodgingPlaceholder")} maxLength={80} />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">{t("phone")}</span>
          <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="593991234567" maxLength={20} />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">{t("reward")}</span>
          <Input value={form.reward} onChange={(e) => setForm({ ...form, reward: e.target.value })} placeholder={t("rewardPlaceholder")} maxLength={120} />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">{t("code")}</span>
          <Input
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20) })}
            placeholder={t("codePlaceholder")}
          />
        </label>
        <div className="flex items-end">
          <Button type="button" onClick={() => void create()} disabled={creating || !form.name.trim() || !hasNumber}>
            {creating ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
            {t("create")}
          </Button>
        </div>
      </div>

      {/* Ranking */}
      {hosts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ol className="grid gap-2">
          {hosts.map((h, i) => (
            <li key={h.code} className="grid gap-2 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <span className="mr-2 font-semibold text-muted-foreground">#{i + 1}</span>
                  <span className="font-medium text-foreground">{h.name}</span>{" "}
                  <span className="text-xs text-muted-foreground">
                    {h.host.lodging ? `${h.host.lodging} · ` : ""}#{h.code}
                  </span>
                </div>
                <div className="text-sm font-semibold text-foreground">{money(h.all.sales)}</div>
              </div>
              <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                <div>
                  {t("monthStats", {
                    month,
                    scans: h.month.scans,
                    guests: h.month.guests,
                    orders: h.month.orders,
                    sales: money(h.month.sales),
                  })}
                </div>
                <div>
                  {t("allStats", {
                    scans: h.all.scans,
                    guests: h.all.guests,
                    orders: h.all.orders,
                    sales: money(h.all.sales),
                  })}
                </div>
                {h.countries.length > 0 && (
                  <div className="sm:col-span-2">
                    {t("countries")}: {h.countries.map((c) => `${c.country} (${c.count})`).join(", ")}
                  </div>
                )}
                <div className="sm:col-span-2">
                  {t("rewardLabel")}: {h.host.reward || t("rewardNone")}
                </div>
              </div>

              {editing === h.code ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder={t("name")} maxLength={80} />
                  <Input value={edit.lodging} onChange={(e) => setEdit({ ...edit, lodging: e.target.value })} placeholder={t("lodging")} maxLength={80} />
                  <Input value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} placeholder={t("phone")} maxLength={20} />
                  <Input value={edit.reward} onChange={(e) => setEdit({ ...edit, reward: e.target.value })} placeholder={t("reward")} maxLength={120} />
                  <div className="flex gap-2 sm:col-span-2">
                    <Button type="button" size="sm" onClick={() => void saveEdit(h.code)}>
                      <Save className="mr-1 h-3.5 w-3.5" />
                      {t("save")}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      {t("cancel")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      void downloadQrCard(h, businessName, program.discountPct).catch(() => toast.error(t("qrFailed")))
                    }
                  >
                    <Download className="mr-1 h-3.5 w-3.5" />
                    {t("downloadQr")}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => void copy(h.scanUrl)}>
                    <Copy className="mr-1 h-3.5 w-3.5" />
                    {t("copyLink")}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => void copy(h.summary)}>
                    <Copy className="mr-1 h-3.5 w-3.5" />
                    {t("copySummary")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEdit({ name: h.name, lodging: h.host.lodging, phone: h.host.phone, reward: h.host.reward });
                      setEditing(h.code);
                    }}
                  >
                    <Pencil className="mr-1 h-3.5 w-3.5" />
                    {t("edit")}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => void remove(h)}>
                    <Trash2 className="mr-1 h-3.5 w-3.5" />
                    {t("delete")}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
