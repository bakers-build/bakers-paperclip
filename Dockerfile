# syntax=docker/dockerfile:1
# The deployable Paperclip: the pinned upstream image plus this repository's runtime files at
# /opt/bakers-paperclip, the paths agent/adapter-config.json and the plugin install expect.
# Local development mounts the repository there instead (docker-compose.yml).

# Skills (pinned public sources) and the bridge's and whois' dependencies.
FROM node:24.11.1-alpine@sha256:682368d8253e0c3364b803956085c456a612d738bd635926d73fa24db3ce53d7 AS build
RUN apk add --no-cache git && corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY scripts/skills.sh scripts/collect-skills.mjs scripts/
RUN mkdir agent && sh scripts/skills.sh

# Paperclip v2026.1117.0, pinned by digest.
FROM ghcr.io/paperclipai/paperclip@sha256:bdf38d10544dc6c831e16dc027f23ad586353ef3be1a1b2c6979e63b956aceb1
COPY --from=build /src/node_modules /opt/bakers-paperclip/node_modules
COPY --from=build /src/agent/plugin /opt/bakers-paperclip/agent/plugin
COPY package.json /opt/bakers-paperclip/
COPY agent/mcp.json agent/whois-mcp.mjs /opt/bakers-paperclip/agent/
COPY bakers-bridge/ /opt/bakers-paperclip/bakers-bridge/
