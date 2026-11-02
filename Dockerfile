FROM node:lts-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:alpine

# 10-listen-on-ipv6-by-default.sh runs `apk manifest nginx` on every start,
# which can stall for minutes on slow storage (nginx never listens meanwhile).
# We replace default.conf anyway, so the script has nothing to do.
RUN rm -f /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh

# Upstream for the same-origin /agent proxy in the template below. The docker
# entrypoint (20-envsubst-on-templates.sh) substitutes it into default.conf at
# container start. Override with -e AGENT_UPSTREAM=host:port when the Agent
# Node is not a `cherry-sandbox` container on the same docker network — e.g.
# host.docker.internal:3099 for an Agent Node on the Docker host, or
# 127.0.0.1:3099 when running with --network host.
ENV AGENT_UPSTREAM=cherry-sandbox:3099

COPY docker/nginx-default.conf.template /etc/nginx/templates/default.conf.template

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
