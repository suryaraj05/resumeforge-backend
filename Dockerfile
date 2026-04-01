# Production API image: Node + system Chromium for Puppeteer PDFs
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install must include devDependencies for tsc; NODE_ENV=production skips them.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "dist/index.js"]
