# Builds the React app, then serves it with Caddy, which also reverse-proxies
# /api and /admin/queues to the backend and gets an HTTPS certificate automatically.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM caddy:2-alpine
COPY --from=build /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile
