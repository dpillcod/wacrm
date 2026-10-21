"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

interface Shift {
  name: string;
  phone: string;
  lastInbound: string | null;
  activeUntil: string | null;
}

/**
 * Settings → My business → staff alerts: each saved number with its name
 * and whether it gets WhatsApp alerts right now (it wrote to the bot in
 * the last 24 h). Saved numbers only — save the list to see new ones.
 */
export function StaffShifts({ countryCode }: { countryCode: string }) {
  const t = useTranslations("Settings.business.staff.shifts");
  const locale = useLocale();
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/business-settings/staff-shifts", { cache: "no-store" });
      const json = (await res.json()) as { shifts?: Shift[] };
      setShifts(json.shifts ?? []);
    } catch {
      setShifts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one fetch on mount
    void load();
  }, [load]);

  const time = (iso: string) =>
    new Date(iso).toLocaleString(locale, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const local = (phone: string) =>
    countryCode && phone.startsWith(countryCode) ? `0${phone.slice(countryCode.length)}` : phone;

  return (
    <div className="grid gap-1.5 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{t("title")}</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          {t("refresh")}
        </Button>
      </div>
      {shifts === null ? (
        <p className="text-xs text-muted-foreground">{t("loading")}</p>
      ) : shifts.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="grid gap-1">
          {shifts.map((s) => (
            <li key={s.phone} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
              <span className="text-foreground">
                {s.name || <span className="text-muted-foreground">{t("noName")}</span>}{" "}
                <span className="text-xs text-muted-foreground">{local(s.phone)}</span>
              </span>
              {s.activeUntil ? (
                <span className="text-xs text-emerald-600 dark:text-emerald-400">
                  ✅ {t("activeUntil", { time: time(s.activeUntil) })}
                </span>
              ) : (
                <span className="text-xs text-amber-600 dark:text-amber-400">
                  ⚠️ {s.lastInbound ? t("expired", { time: time(s.lastInbound) }) : t("never")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{t("hint")}</p>
    </div>
  );
}
