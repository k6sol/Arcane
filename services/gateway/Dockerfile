# Arcane gateway. Build from repository root: docker build -f services/gateway/Dockerfile -t arcane-gateway .
# No npm install: the server uses only Node built-ins (node:http, node:sqlite, fetch) and runs TypeScript directly.
FROM node:24-slim

ENV NODE_ENV=production \
    DATABASE_FILE=/data/gateway.sqlite \
    PORT=8787

WORKDIR /app/services/gateway
COPY services/gateway/package.json ./
COPY services/gateway/src ./src
COPY packages/diagnostics/src/report.ts /app/packages/diagnostics/src/report.ts

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
