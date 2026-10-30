# Self-Service-Portal – App und Worker (ein Image, Befehl entscheidet: serve | worker | user:create …)
#
# Laufzeit-Image: distroless (kein Shell, kein Paketmanager, Benutzer "nonroot").
# Das Portal hat keine npm-Laufzeitabhängigkeiten – es wird nur Node.js selbst benötigt.

ARG NODE_VERSION=24

# ---------------------------------------------------------------- Build
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /src
COPY package.json tsconfig.json ./
COPY src ./src
COPY tools/build-web.ts ./tools/build-web.ts
RUN node --disable-warning=ExperimentalWarning tools/build-web.ts \
 && mkdir -p /out/data && chmod 700 /out/data

# ---------------------------------------------------------------- Laufzeit
FROM gcr.io/distroless/nodejs${NODE_VERSION}-debian12:nonroot
ARG APP_VERSION=dev
LABEL org.opencontainers.image.title="zammad-service-portal" \
      org.opencontainers.image.description="Self-Service-Portal für Zammad mit Microsoft-Anmeldung" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.source="https://github.com/Hundexe/Zammad-Service-Portal"
WORKDIR /app
COPY --chown=0:0 package.json ./
COPY --chown=0:0 src ./src
COPY --chown=0:0 --from=build /src/dist/web ./dist/web
COPY --chown=65532:65532 --from=build /out/data /data
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    DATA_DIR=/data \
    WEB_DIR=/app/dist/web \
    PORT=3000 \
    NODE_OPTIONS="--disable-warning=ExperimentalWarning --max-old-space-size=384"
USER 65532:65532
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["/nodejs/bin/node", "src/server/cli.ts", "healthcheck"]
ENTRYPOINT ["/nodejs/bin/node", "src/server/cli.ts"]
CMD ["serve"]
