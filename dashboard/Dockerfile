# The Zupersync delivery log — Next.js on :3021.
#
# Build context is this directory (set Coolify's base directory to `dashboard`).
#
# Every page is behind HTTP Basic sign-in (src/middleware.ts): set DASHBOARD_USER
# and DASHBOARD_PASSWORD on the container, or it answers 503. /healthz is open and
# returns no data.

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
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3021/healthz >/dev/null || exit 1
CMD ["node", "server.js"]
