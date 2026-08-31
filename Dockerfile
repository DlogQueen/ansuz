# BMDC server: the HTTP bridge that carries the crew's and receptionist's
# webhooks, plus the perception WebSocket and the scheduled jobs.
#
# This is a long-running process, not a set of serverless functions. It holds a
# WebSocketServer open and runs two setIntervals (memory consolidation, and the
# BMDC adapt cycle when enabled). Those do not survive on a platform that
# freezes the process between requests -- see docs/deploy.md.

FROM node:22-slim AS build
WORKDIR /app

# Install with dev dependencies so tsc is available for the build.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npx tsc

# ---------------------------------------------------------------------------
# Runtime: production dependencies and compiled JS only. tsx and typescript
# stay behind in the build stage.
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Run unprivileged. The node image ships a `node` user for exactly this.
USER node

EXPOSE 8787
ENV CHAT_SERVER_PORT=8787

CMD ["node", "dist/scripts/server.js"]
