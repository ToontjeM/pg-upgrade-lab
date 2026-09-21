FROM node:20-alpine
# docker-cli + the compose plugin (no daemon) -- talks to the host's Docker
# socket (bind-mounted in, see docker-compose.yml) to promote a standby
# container and, for the Reliability tab's "reset" button, to recreate that
# pillar's containers/volumes via `docker compose` itself.
RUN apk add --no-cache docker-cli docker-cli-compose
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
