# The Zupersync delivery log — Next.js on :3021.
#
# Build context is this directory (set Coolify's base directory to `dashboard`).
#
# SECURITY: this app authenticates nobody and renders stored webhook bodies,
# which contain customer names, addresses and job details. Put authentication in
# front of it — Coolify basic auth, an IP allowlist, or a private network — before
# exposing it on a public hostname.

FROM node:24-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile


FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# next.config.ts sets output: "standalone", so this emits a self-contained server
# with only the modules actually imported — no node_modules copy in the runtime.
RUN pnpm build


FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static

ENV PORT=3021
# Without this the standalone server binds localhost and nothing outside the
# container can reach it.
ENV HOSTNAME=0.0.0.0
EXPOSE 3021

USER node
CMD ["node", "server.js"]
