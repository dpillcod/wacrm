#!/bin/sh
# Swaps the placeholder tokens baked into the build (see Dockerfile) for
# the real NEXT_PUBLIC_* values from the container's runtime environment,
# across every compiled file that might contain them, then starts the
# server. This lets the same image be built once with no secrets and
# reused across environments/domains, and works even on platforms that
# don't forward "Environment Variables" as Docker build args.
set -eu

esc() {
  printf '%s' "$1" | sed -e 's/[\&|]/\\&/g'
}

replace() {
  token="$1"
  value="$2"
  if [ -n "$value" ]; then
    escaped="$(esc "$value")"
    find /app -type f \( -name '*.js' -o -name '*.html' -o -name '*.json' -o -name '*.rsc' \) -print0 \
      | xargs -0 sed -i "s|$token|$escaped|g"
  fi
}

replace 'https://__NEXT_PUBLIC_SUPABASE_URL__.invalid' "${NEXT_PUBLIC_SUPABASE_URL:-}"
replace '__NEXT_PUBLIC_SUPABASE_ANON_KEY__' "${NEXT_PUBLIC_SUPABASE_ANON_KEY:-}"
replace 'https://__NEXT_PUBLIC_SITE_URL__.invalid' "${NEXT_PUBLIC_SITE_URL:-}"
replace '__NEXT_PUBLIC_APP_LOCALE__' "${NEXT_PUBLIC_APP_LOCALE:-}"

exec node server.js
