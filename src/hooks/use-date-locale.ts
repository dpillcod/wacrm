"use client";

import { useLocale } from "next-intl";
import { es } from "date-fns/locale";
import type { Locale } from "date-fns";

/**
 * The date-fns locale for the app's language, for `format` /
 * `formatDistanceToNow` ("hace 5 minutos", "10 oct"). English is
 * date-fns' default, so it needs none.
 */
export function useDateLocale(): Locale | undefined {
  const locale = useLocale();
  return locale.startsWith("es") ? es : undefined;
}
