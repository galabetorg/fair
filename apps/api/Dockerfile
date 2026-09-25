# Optional container build. The VPS runs PM2 directly; this exists for anyone who prefers containers.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @galabet/fair build && pnpm --filter api build

FROM node:22-alpine
RUN corepack enable
WORKDIR /repo
COPY --from=build /repo /repo
ENV NODE_ENV=production VECTORS_DIR=/repo/vectors
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
