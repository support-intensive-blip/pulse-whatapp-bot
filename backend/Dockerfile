# Backend only — the dashboard (../frontend) is built and hosted by Netlify.
FROM node:20-bullseye-slim

# ffmpeg: voice-note conversion for Whisper. No Chromium — WhatsApp goes through
# the Gallabox API instead of a headless WhatsApp Web session.
RUN apt-get update && apt-get install -y \
    curl \
    ffmpeg \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p data logs tmp uploads knowledge-base

COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD curl -f http://localhost:3000/health || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
