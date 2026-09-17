# Open Glean production image.
#
# Multi-stage: install and build with the full toolchain, then copy only the
# standalone server into a small runtime. next.config.ts sets
# output: "standalone", which produces that server under .next/standalone.

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# OPEN_GLEAN_SESSION_SECRET is required at runtime, not at build time. A build-time
# value keeps the config check quiet during `next build`; the real secret is
# supplied when the container runs.
ENV OPEN_GLEAN_SESSION_SECRET=build-time-placeholder-16chars
RUN npm run build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Run as a non-root user.
RUN useradd --system --uid 1001 open-glean
COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# The DocumentDB CA bundle is read at runtime by lib/mongo.ts when a cluster
# endpoint is configured. It is a public certificate, safe to ship.
COPY --from=build /app/certs ./certs
USER open-glean
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
