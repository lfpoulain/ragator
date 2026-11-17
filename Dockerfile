# Ragator : une seule image, tout compris (PostgreSQL 17 + ParadeDB, application, interface web).
#   docker compose up -d --build        → http://localhost:3210
# Les données (base, vidéos, réglages) vivent dans le volume /data.

FROM node:24-slim AS app
WORKDIR /app
COPY package.json package-lock.json ./
# tsx exécute le TypeScript directement : les dépendances de développement sont nécessaires.
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY schemas ./schemas

FROM paradedb/paradedb:0.25.9-pg17
COPY --from=app /usr/local/bin/node /usr/local/bin/node
COPY --from=app /app /app
COPY docker/entrypoint.sh /usr/local/bin/ragator-entrypoint.sh
COPY docker/pg_hba.conf /etc/ragator/pg_hba.conf
COPY docker/ragator /usr/local/bin/ragator
RUN chmod 755 /usr/local/bin/ragator-entrypoint.sh /usr/local/bin/ragator \
 && chmod 644 /etc/ragator/pg_hba.conf \
 && mkdir -p /data \
 && node --version

ENV POSTGRES_USER=ragator \
    POSTGRES_PASSWORD=ragator \
    POSTGRES_DB=ragator \
    PGDATA=/data/postgres \
    DATABASE_URL=postgres://ragator:ragator@127.0.0.1:5432/ragator \
    CORPUS_DIR=/data/corpus \
    WEB_HOST=0.0.0.0

WORKDIR /app
VOLUME ["/data"]
EXPOSE 3210
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3210/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["ragator-entrypoint.sh"]
