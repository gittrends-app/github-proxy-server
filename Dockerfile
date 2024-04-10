# ---- Base Node ----
FROM node:18 AS base
WORKDIR /app
COPY package*.json ./

# ---- Dependencies ----
FROM base AS dependencies
RUN npm install

# ---- Test ----
# run linters, setup and tests
FROM dependencies AS test
COPY . .
RUN npm run test

# ---- Build ----
FROM test AS build
RUN npm run build

# ---- Release ----
FROM node:18-alpine AS release
# Create app directory
WORKDIR /app

# Install app dependencies
COPY --from=dependencies /app/package*.json ./
RUN npm ci --only=production

# Bundle app source
COPY --from=build /app/dist ./dist

EXPOSE 3000

ENTRYPOINT [ "node", "dist/cli.js" ]
CMD [ "--help" ]