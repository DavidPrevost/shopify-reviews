# syntax=docker/dockerfile:1.7

# Build deps stage — has python3/make/g++ for compiling native modules (better-sqlite3)
FROM node:22-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json esbuild.config.mjs ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# Production deps only — recompile better-sqlite3 against runtime arch
FROM node:22-alpine AS prod-deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# sqlite (CLI) is small and useful for ops/debugging against /app/data/reviews.db
RUN apk add --no-cache sqlite
COPY package.json package-lock.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
EXPOSE 8080
CMD ["node", "dist/index.js"]
