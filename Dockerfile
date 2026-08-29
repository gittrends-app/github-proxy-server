# ---- Base Node ----
FROM node:24 AS base
WORKDIR /app
COPY package.json yarn.lock ./

# ---- Dependencies ----
FROM base AS dependencies
RUN corepack enable && yarn install --frozen-lockfile --ignore-scripts

# ---- Build ----
FROM dependencies AS build
COPY . .
RUN npm run build

# ---- Release ----
FROM node:24-alpine AS release
# Create app directory
WORKDIR /app

# Install curl for healthcheck and tini for proper signal handling
RUN apk add --no-cache curl tini

# Install app dependencies
COPY --from=dependencies /app/package.json /app/yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile --production=true --ignore-scripts

# Bundle app source
COPY --from=build /app/dist ./dist

# Default port (configurable via PORT environment variable)
EXPOSE ${PORT:-3000}

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3000}/status || exit 1

ENTRYPOINT ["/sbin/tini", "--", "node", "dist/cli.js"]
