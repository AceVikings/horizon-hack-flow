# Flow cloud: gateway (web app + auth) + owner service + daemon/trader, one container, three processes.
# Build:  docker build -t flow-cloud .
# Run:    docker run -p 8080:8080 -v flow-data:/data -e FLOW_ORIGIN=https://<host> -e FLOW_PASSWORD=… \
#           -e ATE_AGENT_SIGNER=secret -e ATE_AGENT_KEY_ENC=… -e ATE_AGENT_KEY_SECRET=… \
#           -e ATE_OWNER_SIGNER=secret -e ATE_OWNER_KEY_ENC=… -e ATE_OWNER_KEY_SECRET=… flow-cloud
# Contract bytecode: contracts/artifacts/{PolicyVault,SupraAggregatorAdapter}.json ({ "bytecode": "0x…" }), written by
# scripts/cloud-deploy-branch.sh from a local `forge build`.

ARG NODE=node:22-bookworm-slim

# ---------------------------------------------------------------- build
FROM ${NODE} AS build
ENV CI=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 PNPM=pnpm@9.15.0
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN npx -y ${PNPM} install --frozen-lockfile
RUN npx -y ${PNPM} --filter "@ate/cloud..." --filter "@ate/daemon..." --filter "@ate/owner..." run build \
 && npx -y ${PNPM} --filter @ate/desktop run build:web
# Production dependencies only (no electron, vite, tsup, vitest).
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules agents/*/node_modules \
 && npx -y ${PNPM} install --frozen-lockfile --prod \
 && rm -rf apps/desktop/src apps/desktop/node_modules apps/site apps/worker apps/cli/src \
 && find . -name "*.map" -path "*/dist/*" -delete

# ---------------------------------------------------------------- CLIProxyAPI (MIT), official release, checksum-verified
FROM ${NODE} AS cliproxy
ARG CLIPROXY_VERSION=8.0.51
ARG TARGETARCH=amd64
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /dl
RUN set -eu; f="CLIProxyAPI_${CLIPROXY_VERSION}_linux_${TARGETARCH}.tar.gz"; \
    base="https://github.com/router-for-me/CLIProxyAPI/releases/download/v${CLIPROXY_VERSION}"; \
    curl -fsSLO "$base/$f"; curl -fsSLO "$base/checksums.txt"; \
    grep " $f\$" checksums.txt | sha256sum -c -; \
    mkdir out; tar -xzf "$f" -C out; \
    bin="$(find out -type f -iname 'cli-proxy-api' -o -type f -iname 'CLIProxyAPI' | head -1)"; \
    install -m 0755 "$bin" /usr/local/bin/cli-proxy-api

# ---------------------------------------------------------------- runtime
FROM ${NODE}
ENV NODE_ENV=production ATE_HOME=/data PORT=8080 FLOW_TRUST_PROXY=1 FLOW_CHAIN_ID=133 \
    ATE_CLIPROXY_BIN=/usr/local/bin/cli-proxy-api ATE_DEPLOYMENTS=/app/deployments/133.json
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin flow && mkdir -p /data && chown flow:flow /data
WORKDIR /app
COPY --from=build --chown=root:root /app /app
COPY --from=cliproxy /usr/local/bin/cli-proxy-api /usr/local/bin/cli-proxy-api
USER flow
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/cloud/dist/bin.js"]
