FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* pnpm-lock.yaml* .npmrc* ./
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/ui/package.json packages/ui/
COPY packages/config/package.json packages/config/
RUN if [ -f pnpm-lock.yaml ]; then \
      corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile; \
    else \
      npm install --no-audit --no-fund; \
    fi

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN if [ -f pnpm-lock.yaml ]; then \
      corepack enable && pnpm --filter @attend/web build; \
    else \
      npm run build --workspace @attend/web; \
    fi

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
COPY --from=builder /app/apps/web/.next ./.next
COPY --from=builder /app/apps/web/public ./public
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/web/package.json ./package.json
USER node
EXPOSE 3000
CMD ["npx", "next", "start", "--port", "3000"]
