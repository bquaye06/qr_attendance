FROM node:22-bookworm-slim AS base
ENV CI=true \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false
WORKDIR /app

# Workspace manifests first so dependency layers cache independently of source.
COPY package.json package-lock.json* pnpm-lock.yaml* .npmrc* ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/ui/package.json packages/ui/
COPY packages/config/package.json packages/config/

RUN if [ -f pnpm-lock.yaml ]; then \
      corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile; \
    else \
      npm install --no-audit --no-fund; \
    fi

COPY tsconfig.base.json turbo.json ./
COPY packages ./packages
COPY apps/api ./apps/api

RUN if [ -f pnpm-lock.yaml ]; then pnpm --filter @attend/api build; else npm run build --workspace @attend/api; fi

ENV NODE_ENV=production
EXPOSE 4000
USER node
CMD ["node", "apps/api/dist/server.js"]
