# Paperclip agent runner: the target of a Paperclip "ssh" execution
# environment. The Paperclip server opens an SSH session per run and executes
# the agent CLI here, so agents never share a process space, environment or
# filesystem with the server and its secrets.
#
# Paperclip's SSH driver needs sh, tar and git (the workspace arrives as a tar
# plus a git bundle), node (it runs the callback bridge), and the agent CLIs.
# The base is pinned by digest and the CLIs by version (Renovate bumps both);
# apt packages float, so a rebuild picks up Debian security fixes.
#
# Toolchains beyond the base set come from each repo's own flake, through
# single-user Nix: `nix develop -c <cmd>` (see /etc/profile.d and README).

# Nix, as one static binary (no store closure of its own), so it lives in the
# read-only image while the store (/nix) is the runner's volume. Realised by
# store path from cache.nixos.org, whose signature and NAR hash the nixos/nix
# image verifies; the binary's own hash is pinned too, so the image does not
# rest on that key alone.
#
# To bump (Renovate opens a PR for a new NIX_VERSION but cannot do this):
#   1. NIX_STATIC: `nix eval --raw nixpkgs#pkgsStatic.nix.outPath` on a
#      nixpkgs that has the new version;
#   2. the nixos/nix tag and digest below, to the same version;
#   3. NIX_STATIC_SHA256: build once, take the hash from the failing check.
# renovate: datasource=github-releases depName=NixOS/nix
ARG NIX_VERSION=2.34.8
FROM nixos/nix:2.34.8@sha256:1a711b619c8a713eff32c3f8d8781b3b4d0130cb91c0a57f67e87abfeeb90b01 AS nix
ARG NIX_STATIC=/nix/store/3xmxs0yzg4z038drg96wds1z5h1mggk6-nix-static-x86_64-unknown-linux-musl-2.34.8
ARG NIX_STATIC_SHA256=7363d39abe68fdc3311b2243c22ce219df384ee9ae236dd603df7b6ae62cbd15
RUN nix-store --realise "$NIX_STATIC" \
 && install -m 755 "$NIX_STATIC/bin/nix" /nix-static \
 && echo "$NIX_STATIC_SHA256  /nix-static" | sha256sum -c - \
 && /nix-static --version

FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

# ripgrep and fd (Debian's fdfind, which pi also looks for): for agent CLIs
# that want system rg/fd (pi's grep and find tools; Claude Code bundles its own
# rg); without them some try to download one at run time, which fails behind
# restricted egress. The rest is the base toolset agents expect (DIL-889); the
# image is not the security boundary (node alone can do what these do).
# xz-utils: Nix unpacks .tar.xz sources and NARs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      fd-find \
      file \
      git \
      jq \
      less \
      make \
      openssh-server \
      python3 \
      python3-venv \
      ripgrep \
      tini \
      unzip \
      xz-utils \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/ssh/ssh_host_*

# Installed as root: the global modules stay root-owned and, on a read-only
# root filesystem, immutable to the agent user.
# renovate: datasource=npm depName=@anthropic-ai/claude-code
ARG CLAUDE_CODE_VERSION=2.1.323
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 && claude --version \
 && rm -rf /root/.claude /root/.claude.json

# pi (Paperclip's pi_local adapter): pinned to the version the adapter
# installs itself (SANDBOX_INSTALL_COMMAND in its index.ts); pi breaks its CLI
# between 0.x minors, so bump it only with Paperclip's adapter pin.
# renovate: datasource=npm depName=@earendil-works/pi-coding-agent
ARG PI_VERSION=0.74.0
RUN npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && npm cache clean --force \
 && pi --version \
 && rm -rf /root/.pi

# Claude Code's managed settings take precedence over user and project ones:
# only managed hooks run (none are defined), no self-update (it would install
# into the writable home and defeat the pin), no non-essential traffic.
COPY managed-settings.json /etc/claude-code/managed-settings.json
COPY profile.sh /etc/profile.d/paperclip-runner.sh

# Install hygiene: npm never runs dependency install scripts unless a run
# opts in per command (`--ignore-scripts=false`), which review can see.
COPY npmrc /usr/local/etc/npmrc

# Nix: the binary and its classic-command names, and an image-owned nix.conf.
# The user's own nix.conf (~/.config/nix) is reset at every start.
COPY --from=nix /nix-static /usr/local/bin/nix
RUN for n in nix-build nix-collect-garbage nix-env nix-hash nix-instantiate \
      nix-prefetch-url nix-shell nix-store; do \
      ln -s nix "/usr/local/bin/$n"; \
    done \
 && nix --version
COPY nix.conf /etc/nix/nix.conf
# The mount point for the store volume; owned by the agent user so a local
# `docker run` without the volume works too.
RUN mkdir -m 755 /nix && chown 1000:1000 /nix

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

# sshd runs as the image's node user (UID 1000), so it can only ever log that
# user in. Host and authorized keys are mounted from a Secret at /keys and
# copied into place by the entrypoint.
USER 1000:1000
WORKDIR /home/node
EXPOSE 2222
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
