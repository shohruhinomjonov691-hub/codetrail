# syntax=docker/dockerfile:1
# CodeTrail HTTP API + UI. No secrets, data or model weights in the image: the key comes from the
# runtime env file, data and the embedding model are mounted read-only (see compose.yaml).
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json models.lock.json ./
COPY web ./web
USER node
EXPOSE 8080
CMD ["node", "dist/cli.js", "serve", "--host", "0.0.0.0", "--port", "8080"]
