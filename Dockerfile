# syntax=docker/dockerfile:1

FROM node:22-alpine AS base

# ---- deps ----------------------------------------------------------------
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build -----------------------------------------------------------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next.js inlines every `process.env.NEXT_PUBLIC_*` reference as a
# literal string at build time — in *every* bundle (server, middleware,
# and client), not just client code. PaaS platforms that build straight
# from a Dockerfile (EasyPanel included) generally don't forward the
# service's runtime "Environment Variables" as `--build-arg`s, so the
# real values aren't available here. Bake distinctive placeholder
# tokens instead; docker-entrypoint.sh swaps them for the real runtime
# values across the compiled output before the server starts.
# The URL-shaped placeholders must be syntactically valid URLs — the
# Supabase client constructs sub-resource URLs from them (`new
# URL('rest/v1', supabaseUrl)`) even during static-page prerendering at
# build time, and a non-URL string throws immediately.
ENV NEXT_PUBLIC_SUPABASE_URL=https://__NEXT_PUBLIC_SUPABASE_URL__.invalid \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=__NEXT_PUBLIC_SUPABASE_ANON_KEY__ \
    NEXT_PUBLIC_SITE_URL=https://__NEXT_PUBLIC_SITE_URL__.invalid \
    NEXT_PUBLIC_APP_LOCALE=__NEXT_PUBLIC_APP_LOCALE__

RUN npm run build

# ---- runtime ---------------------------------------------------------
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/messages ./messages
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --chmod=755 docker-entrypoint.sh ./docker-entrypoint.sh

# `sed -i` (used by the entrypoint) creates a temp file in the same
# directory before renaming it over the original, so nextjs needs write
# access to the directories too, not just the files in them.
RUN chown -R nextjs:nodejs /app

USER nextjs

ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
