# The Zupersync sync service — Express on :3020.
#
# Two stages so the runtime image carries no build toolchain: esbuild, tsx and
# typescript are devDependencies and never reach the final layer.
#
# The build step matters more than it looks. src/lib/ is the sync engine copied
# from JMS, and its relative imports are extensionless ("./operators"). Under
# "type": "module" Node refuses those, so `tsc` output would die at runtime with
# ERR_MODULE_NOT_FOUND — it typechecks and it runs under tsx, and it fails only
# once deployed. esbuild bundles our own source and resolves them, leaving
# node_modules external.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --include=dev is NOT redundant. Deployment platforms inject the application's
# environment into the build (Coolify passes every variable as a build ARG), so
# NODE_ENV=production — which this service needs at RUNTIME, or the receiver
# would process unverified deliveries — arrives here too and makes a bare
# `npm ci` skip devDependencies. esbuild is a devDependency, so the next line
# fails with "sh: esbuild: not found". It builds locally, where nothing exports
# NODE_ENV, and fails only on the platform.
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only (@supabase/supabase-js, express, dotenv).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# Carried so the SQL that defines this service's own tables ships with it.
COPY migrations ./migrations

# Coolify sets PORT; this is the fallback and what EXPOSE documents.
ENV PORT=3020
EXPOSE 3020

# /health returns 503 when the database is unreachable, so this reports the
# thing that actually matters rather than merely that the process is alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3020)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "dist/index.js"]
