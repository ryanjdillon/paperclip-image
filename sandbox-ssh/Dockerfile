# The SSH sandbox provider plugin, alone: package.json and the self-contained
# dist/ at the image root. The Paperclip server image copies it in with
# `COPY --from=<this image>@sha256:… / /opt/paperclip-plugins/sandbox-ssh/`.

# The build stage runs on the build machine's own architecture: its output is
# plain JavaScript, so every platform gets the same files.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:190bcf5115694c9d3c4d654a1aa88177d77600a06d67972fd7bf4cf224f7692c AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack prepare --activate && pnpm install --frozen-lockfile
COPY esbuild.config.mjs tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM scratch
LABEL org.opencontainers.image.source="https://github.com/ryanjdillon/paperclip-image" \
      org.opencontainers.image.description="Paperclip sandbox provider plugin that runs on an existing SSH server" \
      org.opencontainers.image.licenses="MIT"
COPY package.json /package.json
COPY --from=build /src/dist /dist
