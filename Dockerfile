# Playwright's own image already has Chromium and every system library it
# needs. Rebuild this whenever you bump the playwright version in package.json -
# the tag below must match.
FROM mcr.microsoft.com/playwright:v1.63.0-jammy

WORKDIR /app

# Install dependencies first so this layer is cached across code changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# Chromium cannot use its sandbox as root, which is how Render runs containers.
# The script also sets this automatically, this makes it explicit for the image.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_ENV=production

# No DISPLAY, so the script turns headless on by itself. Said here too so the
# container config and the script cannot disagree.
ENV HEADLESS=1

# Writable space for the browser profile, screenshots and logs.
RUN mkdir -p /app/logs /app/shots /app/.chrome-profile

# The dashboard is HTTP, so the platform needs a port. Render sets PORT=10000
# for web services; the server falls back to 3000 elsewhere.
ENV PORT=3000
EXPOSE 3000

# Serves the dashboard and supervises one zefame.js process per workflow.
# A background worker is not enough - a worker cannot answer HTTP.
CMD ["node", "server.js"]
