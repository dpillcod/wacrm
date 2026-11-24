'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Smartphone } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * "Connect WhatsApp Business" — Meta Embedded Signup for numbers that
 * keep using the WhatsApp Business app on the phone (coexistence).
 * The Facebook JS SDK is loaded only when the button is clicked.
 */

interface SignupConfig {
  available: boolean;
  missing?: string[];
  appId?: string;
  configId?: string;
  graphVersion?: string;
}

interface SignupSession {
  phone_number_id?: string;
  waba_id?: string;
}

type FbLoginResponse = { authResponse?: { code?: string } | null };
type FbSdk = {
  init: (opts: Record<string, unknown>) => void;
  login: (cb: (r: FbLoginResponse) => void, opts: Record<string, unknown>) => void;
};

declare global {
  interface Window {
    FB?: FbSdk;
    fbAsyncInit?: () => void;
  }
}

function loadSdk(appId: string, version: string): Promise<FbSdk> {
  return new Promise((resolve, reject) => {
    if (window.FB) return resolve(window.FB);
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve(window.FB!);
    };
    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => reject(new Error('sdk'));
    document.body.appendChild(script);
  });
}

export function CoexistenceSignup({ hasNumber, onConnected }: { hasNumber: boolean; onConnected: () => void }) {
  const t = useTranslations('Settings.whatsapp.coexistence');
  const [config, setConfig] = useState<SignupConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const session = useRef<SignupSession>({});

  useEffect(() => {
    fetch('/api/whatsapp/embedded-signup')
      .then((r) => (r.ok ? r.json() : null))
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  // The signup popup reports the chosen WABA / number via postMessage.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      try {
        if (!/(^|\.)facebook\.com$/.test(new URL(event.origin).hostname)) return;
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;
        if (data.event === 'CANCEL') {
          setBusy(false);
          setResult({ ok: false, text: t('cancelled') });
          return;
        }
        // v4 sends data.waba_id; v5 sends data.messaging_account_ids (array).
        const wabaId = data.data?.waba_id ?? (Array.isArray(data.data?.messaging_account_ids) ? data.data.messaging_account_ids[0] : undefined);
        if (wabaId) session.current = { waba_id: wabaId, phone_number_id: data.data?.phone_number_id };
      } catch {
        // other postMessage traffic from facebook.com
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [t]);

  const finish = useCallback(
    async (code: string) => {
      // The session message can arrive a moment after the login callback.
      for (let i = 0; i < 20 && !session.current.waba_id; i++) await new Promise((r) => setTimeout(r, 250));
      if (!session.current.waba_id) {
        setBusy(false);
        setResult({ ok: false, text: t('noSession') });
        return;
      }
      const res = await fetch('/api/whatsapp/embedded-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, ...session.current }),
      });
      const data = await res.json().catch(() => ({}));
      setBusy(false);
      if (!res.ok) {
        setResult({ ok: false, text: t('failed', { error: data.error ?? res.status }) });
        return;
      }
      const syncOk = data.sync?.contacts === 'ok' && data.sync?.history === 'ok';
      setResult({
        ok: true,
        text: t(syncOk ? 'connected' : 'connectedSyncFailed', {
          number: data.phone_info?.display_phone_number ?? '',
        }),
      });
      onConnected();
    },
    [t, onConnected],
  );

  const connect = useCallback(async () => {
    if (!config?.appId || !config.configId) return;
    if (hasNumber && !window.confirm(t('replaceConfirm'))) return;
    setBusy(true);
    setResult(null);
    session.current = {};
    try {
      const fb = await loadSdk(config.appId, config.graphVersion ?? 'v21.0');
      fb.login(
        (response) => {
          const code = response.authResponse?.code;
          if (code) void finish(code);
          else {
            setBusy(false);
            setResult({ ok: false, text: t('cancelled') });
          }
        },
        {
          config_id: config.configId,
          response_type: 'code',
          override_default_response_type: true,
          // Embedded Signup v5: onboarding an existing WhatsApp Business
          // app number is on by default. Without `version`, Meta opens the
          // retired v2/v3 flow (dead since Oct 15, 2026), which only offers
          // a new number verified by SMS — that would take the number off
          // the phone app.
          extras: {
            version: 'v5',
            setup: {},
            featureType: 'whatsapp_business_app_onboarding',
          },
        },
      );
    } catch {
      setBusy(false);
      setResult({ ok: false, text: t('sdkFailed') });
    }
  }, [config, hasNumber, t, finish]);

  if (!config) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground flex items-center gap-2">
          <Smartphone className="size-5" />
          {t('title')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {config.available ? (
          <Button onClick={connect} disabled={busy}>
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            {busy ? t('connecting') : t('button')}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('notConfigured', { vars: (config.missing ?? []).join(', ') })}
          </p>
        )}
        {result && (
          <p className={`text-sm ${result.ok ? 'text-emerald-600' : 'text-destructive'}`}>{result.text}</p>
        )}
        <p className="text-xs text-muted-foreground">{t('note')}</p>
      </CardContent>
    </Card>
  );
}
