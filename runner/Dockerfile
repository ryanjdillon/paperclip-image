# Paperclip agent runner: the target of a Paperclip "ssh" execution
# environment. The Paperclip server opens an SSH session per run and executes
# the agent CLI here, so agents never share a process space, environment or
# filesystem with the server and its secrets.
#
# Paperclip's SSH driver needs sh, tar and git (the workspace arrives as a tar
# plus a git bundle), node (it runs the callback bridge), and the agent CLIs.
# The base is pinned by digest and the CLIs by version (Renovate bumps both);
# apt packages float, so a rebuild picks up Debian security fixes.

FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

# ripgrep and fd (Debian's fdfind, which pi also looks for): for agent CLIs
# that want system rg/fd (pi's grep and find tools; Claude Code bundles its own
# rg); without them some try to download one at run time, which fails behind
# restricted egress.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      openssh-server \
      fd-find \
      ripgrep \
      tini \
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

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

# sshd runs as the image's node user (UID 1000), so it can only ever log that
# user in. Host and authorized keys are mounted from a Secret at /keys and
# copied into place by the entrypoint.
USER 1000:1000
WORKDIR /home/node
EXPOSE 2222
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
