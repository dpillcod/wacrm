"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { BellRing } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { Notification } from "@/types";

/**
 * Makes a new in-app notification impossible to miss on a shop-floor
 * PC: a short chime plus a desktop pop-up (clicking it opens the
 * conversation). The sidebar badge alone was easy to overlook, and with
 * WhatsApp staff alerts limited to staff "on shift", the CRM is the one
 * channel that always works.
 *
 * Browsers only allow the pop-up after the user grants permission, and
 * sound only after they've interacted with the page — so until then a
 * small "Enable order alerts" button is shown; clicking it covers both.
 * Headless otherwise.
 */
export function NotificationAlerts() {
  const t = useTranslations("NotificationAlerts");
  const router = useRouter();
  const audioRef = useRef<AudioContext | null>(null);
  // Rendered client-side only (the dashboard shell waits for auth).
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(() =>
    typeof window !== "undefined" && "Notification" in window
      ? window.Notification.permission
      : "unsupported",
  );

  const unlockAudio = useCallback(() => {
    try {
      if (!audioRef.current) audioRef.current = new AudioContext();
      if (audioRef.current.state === "suspended") void audioRef.current.resume();
    } catch {
      // No Web Audio — alerts just stay silent.
    }
  }, []);

  // Any click on the page unlocks sound for later alerts.
  useEffect(() => {
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    return () => window.removeEventListener("pointerdown", unlockAudio);
  }, [unlockAudio]);

  const chime = useCallback(() => {
    const ctx = audioRef.current;
    if (!ctx || ctx.state !== "running") return;
    // Two short rising tones — synthesized, so no audio asset to ship.
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = ctx.currentTime + i * 0.18;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.17);
    });
  }, []);

  useEffect(() => {
    const supabase = createClient();
    // RLS scopes these rows to the signed-in user.
    const channel = supabase
      .channel("notifications-alerts")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications" },
        (payload) => {
          const row = payload.new as Notification;
          chime();
          if ("Notification" in window && window.Notification.permission === "granted") {
            const popup = new window.Notification(row.title, {
              body: row.body ?? "",
              tag: row.id,
            });
            popup.onclick = () => {
              window.focus();
              router.push(row.conversation_id ? `/inbox?c=${row.conversation_id}` : "/notifications");
              popup.close();
            };
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [chime, router]);

  const enable = async () => {
    unlockAudio();
    if ("Notification" in window) {
      setPermission(await window.Notification.requestPermission());
    }
    chime();
  };

  if (permission !== "default") return null;
  return (
    <button
      type="button"
      onClick={enable}
      title={t("enableHint")}
      className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-lg hover:opacity-90"
    >
      <BellRing className="h-4 w-4" />
      {t("enable")}
    </button>
  );
}
