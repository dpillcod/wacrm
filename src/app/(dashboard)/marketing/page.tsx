"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { AdLinksPanel, type AdLinkRow } from "@/components/marketing/ad-links-panel";
import { StatusImageMaker } from "@/components/marketing/status-image-maker";
import { HostsPanel, type HostProgram, type HostRow } from "@/components/marketing/hosts-panel";

interface MarketingData {
  links: AdLinkRow[];
  whatsappNumber: string;
  businessName: string;
  countryCode: string;
}

interface HostsData {
  program: HostProgram;
  hosts: HostRow[];
  hasNumber: boolean;
  businessName: string;
  month: string;
}

export default function MarketingPage() {
  const t = useTranslations("Marketing");
  const [data, setData] = useState<MarketingData | null>(null);
  const [hosts, setHosts] = useState<HostsData | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const [res, hostsRes] = await Promise.all([
        fetch("/api/marketing/links", { cache: "no-store" }),
        fetch("/api/marketing/hosts", { cache: "no-store" }),
      ]);
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as MarketingData);
      // The host panel is optional: without migration 051 it just stays hidden.
      setHosts(hostsRes.ok ? ((await hostsRes.json()) as HostsData) : null);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one fetch on mount
    void load();
  }, [load]);

  if (failed) return <p className="p-6 text-sm text-muted-foreground">{t("loadFailed")}</p>;
  if (!data) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-6 p-4 sm:p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("desc")}</p>
      </div>
      <AdLinksPanel links={data.links} whatsappNumber={data.whatsappNumber} onChanged={() => void load()} />
      {hosts && (
        <HostsPanel
          program={hosts.program}
          hosts={hosts.hosts}
          hasNumber={hosts.hasNumber}
          businessName={hosts.businessName}
          month={hosts.month}
          onChanged={() => void load()}
        />
      )}
      <StatusImageMaker
        links={data.links}
        businessName={data.businessName}
        whatsappNumber={data.whatsappNumber}
        countryCode={data.countryCode}
      />
    </div>
  );
}
