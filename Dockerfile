# ---- Build stage: compile TypeScript ----
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage: slim image ----
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Install CLI tools that the gateway's proxy/subscription workflow may invoke externally.
RUN apk add --no-cache curl ca-certificates

# Copy built output + runtime deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /app/dist ./dist

# Persisted settings / stats / free-model cache — owned by the app user
RUN mkdir -p /data && chown -R node:node /data
ENV OCFREERELAY_SETTINGS_PATH=/data/settings.json
ENV OCFREERELAY_STATS_PATH=/data/worker-stats.json

EXPOSE 9876

# Healthcheck hits the gateway /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9876/health >/dev/null 2>&1 || exit 1

USER node
VOLUME ["/data"]

CMD ["node", "dist/index.js"]