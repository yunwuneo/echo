FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS development
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/server/package.json packages/server/package.json
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS runtime
LABEL org.opencontainers.image.title="Echo" org.opencontainers.image.version="0.6.0"
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/server/package.json packages/server/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=development /app/dist ./dist
COPY migrations ./migrations
COPY packages/push-relay/src/schema.sql ./packages/push-relay/src/schema.sql
USER node
EXPOSE 3000
CMD ["node", "dist/packages/server/src/api.js"]
