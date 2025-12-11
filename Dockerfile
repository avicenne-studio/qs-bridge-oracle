# ---------- BUILD STAGE ----------
FROM node:24-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev


# ---------- PRODUCTION STAGE ----------
FROM node:24-slim AS production
WORKDIR /app
ENV NODE_ENV=production

# SQLite runtime directory
RUN mkdir -p /data && chown -R node:node /data

# Copy build artifacts as non-root
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/README.md ./README.md
COPY --from=build --chown=node:node /app/.env.example ./

USER node

EXPOSE 3000
CMD ["node", "dist/server.js"]
