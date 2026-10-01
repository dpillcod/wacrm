"use client";

import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Loader2, Store } from "lucide-react";
import { useTranslations } from "next-intl";

import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { BusinessSettings, CrossSellRule } from "@/lib/business/settings";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * Settings → My business: everything about the business the bot works
 * for (see src/lib/business/settings.ts). Loaded from and saved to
 * /api/business-settings; admins edit, everyone else reads.
 *
 * Lists are edited as plain text (one per line, or "word = text" for
 * cross-sell) and turned back into lists on save.
 */

type Texts = BusinessSettings["texts"];
type Board = BusinessSettings["orderBoard"];

interface Draft {
  settings: BusinessSettings;
  staffPhones: string;
  checkInWords: string;
  blockedTerms: string;
  crossSell: string;
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
// Shown Monday first, as people read a week.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const TEXT_KEYS: (keyof Texts)[] = [
  "outOfHours",
  "idleNudge",
  "captureFailed",
  "fallbackHandoff",
  "nonTextReply",
  "disambiguationPrompt",
  "editFailed",
  "followUpYes",
  "followUpNo",
  "checkIn",
  "invalidOption",
  "orderAck",
  "humanRequest",
  "resumeOrder",
];
const MESSAGE_KEYS: (keyof Board["messages"])[] = ["paid", "ready", "delivered", "cancelled"];
const STATUS_KEYS: (keyof Board["statusReplies"])[] = [
  "new",
  "quoted",
  "paid",
  "ready",
  "delivered",
  "cancelled",
  "none",
];

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
const words = (text: string) =>
  text
    .split(/[,\n]/)
    .map((w) => w.trim())
    .filter(Boolean);

function toDraft(settings: BusinessSettings): Draft {
  return {
    settings,
    staffPhones: settings.staffPhones.join("\n"),
    checkInWords: settings.checkInWords.join(", "),
    blockedTerms: settings.blockedProducts.terms.join(", "),
    crossSell: settings.crossSell.map((r) => `${r.keyword} = ${r.suggestion}`).join("\n"),
  };
}

function fromDraft(d: Draft): BusinessSettings {
  const crossSell: CrossSellRule[] = lines(d.crossSell)
    .map((l) => {
      const i = l.indexOf("=");
      return i < 0 ? null : { keyword: l.slice(0, i).trim(), suggestion: l.slice(i + 1).trim() };
    })
    .filter((r): r is CrossSellRule => !!r && !!r.keyword && !!r.suggestion);
  return {
    ...d.settings,
    staffPhones: lines(d.staffPhones),
    checkInWords: words(d.checkInWords),
    blockedProducts: { ...d.settings.blockedProducts, terms: words(d.blockedTerms) },
    crossSell,
  };
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-muted-foreground">{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">{title}</CardTitle>
        {description ? (
          <CardDescription className="text-muted-foreground">{description}</CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

export function BusinessSettingsPanel() {
  const { canEditSettings } = useAuth();
  const t = useTranslations("Settings.business");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/business-settings")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { settings: BusinessSettings }) => {
        if (!cancelled) setDraft(toDraft(body.settings));
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadFailed) {
    return <p className="text-sm text-destructive">{t("loadFailed")}</p>;
  }
  if (!draft) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t("loading")}
      </div>
    );
  }

  const s = draft.settings;
  const readOnly = !canEditSettings;

  const edit = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setDirty(true);
  };
  const set = (patch: Partial<BusinessSettings>) => edit({ settings: { ...s, ...patch } });
  const setText = (key: keyof Texts, value: string) => set({ texts: { ...s.texts, [key]: value } });
  const setBoard = (patch: Partial<Board>) => set({ orderBoard: { ...s.orderBoard, ...patch } });

  const text = (key: keyof BusinessSettings, extra?: { type?: string; placeholder?: string }) => (
    <Input
      value={String(s[key] ?? "")}
      onChange={(e) => set({ [key]: e.target.value } as Partial<BusinessSettings>)}
      disabled={readOnly}
      type={extra?.type}
      placeholder={extra?.placeholder}
    />
  );
  const area = (value: string, onChange: (v: string) => void, rows = 3) => (
    <Textarea value={value} onChange={(e) => onChange(e.target.value)} disabled={readOnly} rows={rows} />
  );

  const alwaysOpen = s.openingHours.length === 0;
  const week = alwaysOpen ? Array<[number, number] | null>(7).fill([8, 18]) : s.openingHours;
  const setDay = (day: number, value: [number, number] | null) => {
    const next = [...week];
    next[day] = value;
    set({ openingHours: next });
  };

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const res = await fetch("/api/business-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: fromDraft(draft) }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { settings: BusinessSettings };
      setDraft(toDraft(body.settings));
      setDirty(false);
      toast.success(t("saveSuccess"));
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="max-w-3xl space-y-5 animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t("title")}
        description={t("description")}
        action={<Store className="size-5 text-primary" />}
      />
      {readOnly && <p className="text-xs text-muted-foreground">{t("adminOnlyHint")}</p>}

      <Section title={t("identity.title")} description={t("identity.desc")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("identity.name")}>{text("name")}</Field>
          <Field label={t("identity.city")}>{text("city")}</Field>
          <Field label={t("identity.country")}>{text("country")}</Field>
          <Field label={t("identity.utcOffset")} hint={t("identity.utcOffsetHint")}>
            <Input
              type="number"
              step="0.5"
              value={s.utcOffsetHours}
              onChange={(e) => set({ utcOffsetHours: Number(e.target.value) || 0 })}
              disabled={readOnly}
            />
          </Field>
          <Field label={t("identity.countryCode")} hint={t("identity.countryCodeHint")}>
            {text("phoneCountryCode", { placeholder: "593" })}
          </Field>
        </div>
        <Field label={t("identity.aiDescription")} hint={t("identity.aiDescriptionHint")}>
          {area(s.aiBusinessDescription, (v) => set({ aiBusinessDescription: v }), 2)}
        </Field>
      </Section>

      <Section title={t("links.title")} description={t("links.desc")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("links.website")}>{text("websiteUrl", { placeholder: "https://" })}</Field>
          <Field label={t("links.shop")}>{text("shopUrl", { placeholder: "https://" })}</Field>
          <Field label={t("links.review")} hint={t("links.reviewHint")}>
            {text("googleReviewUrl", { placeholder: "https://g.page/r/…/review" })}
          </Field>
          <Field label={t("links.callCenter")}>{text("callCenterPhone")}</Field>
          <Field label={t("links.woocommerce")} hint={t("links.woocommerceHint")}>
            {text("woocommerceUrl", { placeholder: "https://" })}
          </Field>
          <Field label={t("links.birthdayField")} hint={t("links.birthdayFieldHint")}>
            {text("birthdayFieldName")}
          </Field>
        </div>
      </Section>

      <Section title={t("hours.title")} description={t("hours.desc")}>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={alwaysOpen}
            disabled={readOnly}
            onChange={(e) =>
              set({ openingHours: e.target.checked ? [] : Array<[number, number]>(7).fill([8, 18]) })
            }
          />
          {t("hours.alwaysOpen")}
        </label>
        {!alwaysOpen && (
          <div className="grid gap-2">
            {DAY_ORDER.map((day) => {
              const value = week[day];
              return (
                <div key={day} className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="w-24 text-foreground">{t(`hours.days.${DAYS[day]}`)}</span>
                  <label className="flex items-center gap-1.5 text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={!!value}
                      disabled={readOnly}
                      onChange={(e) => setDay(day, e.target.checked ? [8, 18] : null)}
                    />
                    {t("hours.open")}
                  </label>
                  {value && (
                    <>
                      <Input
                        type="number"
                        min={0}
                        max={24}
                        className="w-20"
                        value={value[0]}
                        disabled={readOnly}
                        onChange={(e) => setDay(day, [Number(e.target.value), value[1]])}
                      />
                      <span className="text-muted-foreground">{t("hours.to")}</span>
                      <Input
                        type="number"
                        min={0}
                        max={24}
                        className="w-20"
                        value={value[1]}
                        disabled={readOnly}
                        onChange={(e) => setDay(day, [value[0], Number(e.target.value)])}
                      />
                    </>
                  )}
                </div>
              );
            })}
            <p className="text-xs text-muted-foreground">{t("hours.hint")}</p>
          </div>
        )}
      </Section>

      <Section title={t("staff.title")} description={t("staff.desc")}>
        <Field label={t("staff.phones")} hint={t("staff.phonesHint")}>
          {area(draft.staffPhones, (v) => edit({ staffPhones: v }), 3)}
        </Field>
        <Field label={t("staff.checkInWords")} hint={t("staff.checkInWordsHint")}>
          {area(draft.checkInWords, (v) => edit({ checkInWords: v }), 1)}
        </Field>
      </Section>

      <Section title={t("rules.title")} description={t("rules.desc")}>
        <Field label={t("rules.blockedTerms")} hint={t("rules.blockedTermsHint")}>
          {area(draft.blockedTerms, (v) => edit({ blockedTerms: v }), 3)}
        </Field>
        <Field label={t("rules.blockedReply")}>
          {area(s.blockedProducts.reply, (v) => set({ blockedProducts: { ...s.blockedProducts, reply: v } }))}
        </Field>
        <Field label={t("rules.crossSell")} hint={t("rules.crossSellHint")}>
          {area(draft.crossSell, (v) => edit({ crossSell: v }), 6)}
        </Field>
      </Section>

      <Section title={t("texts.title")} description={t("texts.desc")}>
        {TEXT_KEYS.map((key) => (
          <Field key={key} label={t(`texts.${key}`)}>
            {area(s.texts[key], (v) => setText(key, v), 2)}
          </Field>
        ))}
      </Section>

      <Section title={t("board.title")} description={t("board.desc")}>
        <Field label={t("board.pipelineName")} hint={t("board.pipelineNameHint")}>
          <Input
            value={s.orderBoard.pipelineName}
            disabled={readOnly}
            onChange={(e) => setBoard({ pipelineName: e.target.value })}
          />
        </Field>
        {MESSAGE_KEYS.map((key) => (
          <Field key={key} label={t(`board.messages.${key}`)}>
            {area(s.orderBoard.messages[key], (v) =>
              setBoard({ messages: { ...s.orderBoard.messages, [key]: v } }),
            2)}
          </Field>
        ))}
        <Field label={t("board.csatQuestion")}>
          {area(s.orderBoard.csatQuestion, (v) => setBoard({ csatQuestion: v }), 2)}
        </Field>
        <Field label={t("board.csatExcellent")} hint={t("board.csatExcellentHint")}>
          {area(s.orderBoard.csatExcellent, (v) => setBoard({ csatExcellent: v }), 2)}
        </Field>
        <Field label={t("board.csatGood")}>
          {area(s.orderBoard.csatGood, (v) => setBoard({ csatGood: v }), 2)}
        </Field>
        <Field label={t("board.csatBad")}>
          {area(s.orderBoard.csatBad, (v) => setBoard({ csatBad: v }), 2)}
        </Field>
        <p className="pt-2 text-sm font-medium text-foreground">{t("board.statusTitle")}</p>
        {STATUS_KEYS.map((key) => (
          <Field key={key} label={t(`board.status.${key}`)}>
            {area(s.orderBoard.statusReplies[key], (v) =>
              setBoard({ statusReplies: { ...s.orderBoard.statusReplies, [key]: v } }),
            2)}
          </Field>
        ))}
      </Section>

      {canEditSettings && (
        <div className="sticky bottom-4 flex justify-end">
          <Button
            onClick={save}
            disabled={saving || !dirty}
            className="bg-primary text-primary-foreground shadow-lg hover:bg-primary/90"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t("saving")}
              </>
            ) : (
              t("save")
            )}
          </Button>
        </div>
      )}
    </section>
  );
}
