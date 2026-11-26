# The SSH sandbox provider plugin, alone: package.json and the self-contained
# dist/ at the image root. The Paperclip server image copies it in with
# `COPY --from=<this image>@sha256:… / /opt/paperclip-plugins/sandbox-ssh/`.

# The build stage runs on the build machine's own architecture: its output is
# plain JavaScript, so every platform gets the same files.
FROM --platform=$BUILDPLATFORM node:26-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9 AS build
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
