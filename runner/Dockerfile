# Paperclip agent runner: the target of a Paperclip "ssh" execution
# environment. The Paperclip server opens an SSH session per run and executes
# the agent CLI here, so agents never share a process space, environment or
# filesystem with the server and its secrets.
#
# Paperclip's SSH driver needs sh, tar and git (the workspace arrives as a tar
# plus a git bundle), node (it runs the callback bridge), and the agent CLIs.
# Everything is pinned: the base by digest, the CLIs by version.

FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

# ripgrep: agent CLIs search with the system rg; without it some try to
# download one at run time, which fails behind restricted egress.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      openssh-server \
      ripgrep \
      tar \
      tini \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/ssh/ssh_host_*

ARG CLAUDE_CODE_VERSION=2.1.323
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 && claude --version

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

# sshd runs as the image's node user (UID 1000), so it can only ever log that
# user in. Host and authorized keys are mounted from a Secret at /keys and
# copied into place by the entrypoint.
USER 1000:1000
WORKDIR /home/node
EXPOSE 2222
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
