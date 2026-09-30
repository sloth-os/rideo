# syntax=docker/dockerfile:1
# Rideo: the studio server (UI with the ffmpeg.wasm editor engine, REST, /mcp, /dav) with native ffmpeg for
# generation and watermarking; the same image runs the mock gateway.

ARG NODE_VERSION=24

# ---- build: install everything, bundle server + mock gateway, build the web app ----------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/mock-gateway/package.json packages/mock-gateway/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci
COPY tsconfig.base.json ./
COPY types types
COPY scripts scripts
COPY packages packages
RUN npm run build

# ---- runtime dependencies of the two bundles (workspace packages are inlined) ------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/mock-gateway/package.json packages/mock-gateway/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev --workspace @rideo/server --workspace @rideo/mock-gateway \
  && npm cache clean --force

# ---- runtime ----------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
  RIDEO_HOST=0.0.0.0 \
  RIDEO_PORT=8787 \
  RIDEO_DATA_DIR=/data \
  RIDEO_WEB_DIST=/app/packages/web/dist
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/server/package.json packages/server/
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/mock-gateway/package.json packages/mock-gateway/
COPY --from=build /app/packages/mock-gateway/dist packages/mock-gateway/dist
COPY --from=build /app/packages/web/dist packages/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RIDEO_PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["tini", "--"]
CMD ["node", "packages/server/dist/main.js"]
