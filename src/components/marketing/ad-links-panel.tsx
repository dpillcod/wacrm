"use client";

import { useState } from "react";
import { Copy, ExternalLink, Loader2, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AD_CHANNELS } from "@/lib/marketing/ad-links";

export interface AdLinkRow {
  code: string;
  name: string;
  channel: string;
  message: string;
  createdAt: string;
  url: string;
  contacts: number;
  orders: number;
}

/**
 * Advertising links: one wa.me link per ad. A customer who writes
 * through it gets tagged with the ad, so each ad's conversations and
 * orders can be counted here.
 */
export function AdLinksPanel({
  links,
  whatsappNumber,
  onChanged,
}: {
  links: AdLinkRow[];
  whatsappNumber: string;
  onChanged: () => void;
}) {
  const t = useTranslations("Marketing.links");
  const [name, setName] = useState("");
  const [channel, setChannel] = useState<string>(AD_CHANNELS[0]);
  const [message, setMessage] = useState("");
  const [code, setCode] = useState("");
  const [saving, setSaving] = useState(false);

  async function create() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/marketing/links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          channel,
          code,
          message: message.trim() || t("defaultMessage", { name: name.trim() }),
        }),
      });
      if (res.status === 409) {
        toast.error(t("codeTaken"));
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      setName("");
      setMessage("");
      setCode("");
      toast.success(t("created"));
      onChanged();
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function remove(link: AdLinkRow) {
    if (!window.confirm(t("confirmDelete", { name: link.name }))) return;
    const res = await fetch(`/api/marketing/links?code=${encodeURIComponent(link.code)}`, { method: "DELETE" });
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

  return (
    <section className="grid gap-4 rounded-lg border border-border bg-card p-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("desc")}</p>
      </div>

      {!whatsappNumber && (
        <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          {t("noNumber")}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          <span className="font-medium">{t("name")}</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("namePlaceholder")} maxLength={80} />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">{t("channel")}</span>
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
          >
            {AD_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm sm:col-span-2">
          <span className="font-medium">{t("message")}</span>
          <Input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t("defaultMessage", { name: name.trim() || t("namePlaceholder") })}
            maxLength={300}
          />
          <span className="text-xs text-muted-foreground">{t("messageHint")}</span>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">{t("code")}</span>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20))}
            placeholder={t("codePlaceholder")}
          />
        </label>
        <div className="flex items-end">
          <Button type="button" onClick={() => void create()} disabled={saving || !name.trim() || !whatsappNumber}>
            {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
            {t("create")}
          </Button>
        </div>
      </div>

      {links.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="grid gap-2">
          {links.map((l) => (
            <li key={l.code} className="grid gap-2 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-medium text-foreground">{l.name}</span>{" "}
                  <span className="text-xs text-muted-foreground">
                    {l.channel} · #{l.code}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {t("stats", { contacts: l.contacts, orders: l.orders })}
                </div>
              </div>
              <div className="break-all rounded bg-muted px-2 py-1 font-mono text-xs text-foreground/80">{l.url}</div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="secondary" onClick={() => void copy(l.url)} disabled={!l.url}>
                  <Copy className="mr-1 h-3.5 w-3.5" />
                  {t("copy")}
                </Button>
                <a
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonVariants({ size: "sm", variant: "ghost" })}
                >
                  <ExternalLink className="mr-1 h-3.5 w-3.5" />
                  {t("test")}
                </a>
                <Button type="button" size="sm" variant="ghost" onClick={() => void remove(l)}>
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                  {t("delete")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
