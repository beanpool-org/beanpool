# =============================================================================
# Stage 1: Builder — install deps, build core → PWA → server
# =============================================================================
FROM node:22-alpine AS builder

WORKDIR /app

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files and lockfile first (for layer caching)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/beanpool-core/package.json ./packages/beanpool-core/
COPY apps/pwa/package.json ./apps/pwa/
COPY apps/server/package.json ./apps/server/

# Copy patches needed by pnpm install
COPY patches ./patches

# Install all dependencies (including devDependencies for building)
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy source code
COPY . .

# Build in dependency order:
#   1. Core protocol library (shared by both PWA and server)
#   2. PWA (Vite → outputs to apps/server/public/)
#   3. Server (tsc → outputs to apps/server/dist/)
RUN cd packages/beanpool-core && pnpm run build
RUN cd apps/pwa && pnpm run build
# PWA build clears apps/server/public/ (emptyOutDir), so copy settings files from static/
COPY apps/server/static/* /app/apps/server/public/
RUN cd apps/server && pnpm run build

# Prune to production-only dependencies
RUN pnpm prune --prod --no-optional

# =============================================================================
# Stage 2: Runtime — clean Alpine with only what's needed to run
# =============================================================================
FROM node:22-alpine AS runtime

# Accept version from CI build args (from git tag)
ARG APP_VERSION=""

WORKDIR /app

# Install native build tools for better-sqlite3 compilation
RUN apk add --no-cache python3 make g++

# Copy production node_modules from builder (including the .pnpm virtual store)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/node_modules/.pnpm ./node_modules/.pnpm

# Copy compiled server (dist + baked-in PWA static files)
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/server/src/db/schema.sql ./apps/server/dist/db/schema.sql
COPY --from=builder /app/apps/server/public ./apps/server/public
COPY --from=builder /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder /app/apps/server/node_modules ./apps/server/node_modules

# Copy compiled core library
COPY --from=builder /app/packages/beanpool-core/dist ./packages/beanpool-core/dist
COPY --from=builder /app/packages/beanpool-core/package.json ./packages/beanpool-core/package.json
COPY --from=builder /app/packages/beanpool-core/node_modules ./packages/beanpool-core/node_modules

# Copy root workspace config for pnpm resolution
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml

# Write version file if provided via build arg (overrides package.json version)
RUN if [ -n "$APP_VERSION" ]; then echo "$APP_VERSION" > /app/.version; fi

WORKDIR /app/apps/server

# Force build better-sqlite3 native bindings for Alpine
RUN npm rebuild better-sqlite3 --build-from-source

# Install su-exec for dropping privileges
RUN apk add --no-cache su-exec

# Clean up build tools to reduce image size
RUN apk del python3 make g++

# Link to GitHub repository to inherit README on GHCR package page
LABEL org.opencontainers.image.source="https://github.com/beanpool-org/beanpool"
LABEL org.opencontainers.image.description="A decentralized mutual credit protocol for independent communities."
LABEL org.opencontainers.image.licenses="MIT"

# Expose the 4-port layout
EXPOSE 8080 8443 4001 4002

# Data directory for genesis, TLS certs, and SQLite
ENV BEANPOOL_DATA_DIR=/data
ENV APP_VERSION=${APP_VERSION}
VOLUME /data

# Copy entrypoint script
COPY --from=builder /app/entrypoint.sh /app/entrypoint.sh

# Run compiled JavaScript via the entrypoint
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "dist/index.js"]
