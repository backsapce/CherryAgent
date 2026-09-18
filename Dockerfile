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

RUN echo '\
server {\
  listen 80;\
  server_name _;\
  root /usr/share/nginx/html;\
  index index.html;\
  location / {\
    try_files $uri $uri/ /index.html;\
  }\
}\
' > /etc/nginx/conf.d/default.conf

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
