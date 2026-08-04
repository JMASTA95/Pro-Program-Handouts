# Puppeteer on Railway: use system Chromium instead of letting
# Puppeteer download its own Chrome (smaller image, reliable in containers).
FROM node:20-slim

# Chromium + fonts (fonts matter — without them PDFs render with tofu boxes)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to skip its Chrome download and use system Chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
