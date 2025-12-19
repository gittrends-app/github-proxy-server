# ---- Base Node ----
FROM node:20 AS base
WORKDIR /app
COPY package*.json ./

# ---- Dependencies ----
FROM base AS dependencies
RUN npm install --force

# ---- Test ----
# run linters, setup and tests
FROM dependencies AS test
COPY . .
RUN npm run test

# ---- Build ----
FROM test AS build
RUN npm run build

# ---- Release ----
FROM node:20-alpine AS release
# Create app directory
WORKDIR /app

# Install curl for healthcheck
RUN apk add --no-cache curl

# Install app dependencies
COPY --from=dependencies /app/package*.json ./
RUN npm ci --omit=dev --ignore-scripts --force

# Bundle app source
COPY --from=build /app/dist ./dist

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/status || exit 1

ENTRYPOINT [ "node", "dist/cli.js" ]