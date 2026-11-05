FROM node:22-bookworm-slim AS build
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY packages/registry packages/registry
COPY packages/ai packages/ai
COPY packages/service packages/service
RUN npm ci --workspace packages/service --include-workspace-root
RUN npm run build --workspace packages/service
RUN node_modules/.bin/esbuild packages/service/tools/acceptance556.ts --outfile=packages/service/dist/tools/acceptance556.mjs --bundle --platform=node --format=esm --target=node22 --external:pg
FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /workspace
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages/service/dist ./service
USER node
CMD ["node","service/tools/acceptance556.mjs"]
