import { getRequestConfig } from 'next-intl/server';

// One explicit import per dictionary. A template-literal import
// (`messages/${locale}.json`) breaks in the Docker image: the build sees
// NEXT_PUBLIC_APP_LOCALE as a placeholder token (see Dockerfile), so the
// path is resolved at build time to a file that doesn't exist, and the
// runtime swap to the real locale comes too late — always English.
const DICTIONARIES = {
  en: () => import('../../messages/en.json'),
  es: () => import('../../messages/es.json'),
} as const;

type Locale = keyof typeof DICTIONARIES;

export function resolveLocale(value: string | undefined): Locale {
  const v = (value ?? '').trim().toLowerCase();
  return v in DICTIONARIES ? (v as Locale) : 'en';
}

export default getRequestConfig(async () => {
  // APP_LOCALE is read at runtime; NEXT_PUBLIC_APP_LOCALE is the older
  // name (baked in at build time, swapped in by docker-entrypoint.sh).
  const locale = resolveLocale(process.env.APP_LOCALE || process.env.NEXT_PUBLIC_APP_LOCALE);
  const messages = (await DICTIONARIES[locale]()).default;
  return { locale, messages };
});
