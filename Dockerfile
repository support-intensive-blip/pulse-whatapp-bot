FROM node:22-bookworm-slim AS dashboard
WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ffmpeg \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV DASHBOARD_DIST=/app/dashboard
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/ ./
COPY --from=dashboard /build/dist ./dashboard
RUN mkdir -p data logs tmp uploads \
    && sed -i 's/\r$//' deploy/docker-entrypoint.sh \
    && chmod +x deploy/docker-entrypoint.sh
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
    CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/health" || exit 1
ENTRYPOINT ["/app/deploy/docker-entrypoint.sh"]
