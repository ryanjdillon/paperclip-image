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
# NIX_VERSION is only a Renovate trigger (nothing reads it): a new Nix release
# opens a PR that reminds us to do the three steps above.
# renovate: datasource=github-releases depName=NixOS/nix
ARG NIX_VERSION=2.34.8
FROM nixos/nix:2.34.8@sha256:1a711b619c8a713eff32c3f8d8781b3b4d0130cb91c0a57f67e87abfeeb90b01 AS nix
ARG NIX_STATIC=/nix/store/3xmxs0yzg4z038drg96wds1z5h1mggk6-nix-static-x86_64-unknown-linux-musl-2.34.8
ARG NIX_STATIC_SHA256=7363d39abe68fdc3311b2243c22ce219df384ee9ae236dd603df7b6ae62cbd15
RUN nix-store --realise "$NIX_STATIC" \
 && install -m 755 "$NIX_STATIC/bin/nix" /nix-static \
 && echo "$NIX_STATIC_SHA256  /nix-static" | sha256sum -c - \
 && /nix-static --version

# Paperclip's own runner (ACP, DIL-968). Its ssh transport cannot copy the
# provider pack to this host, so the image carries the pack and the runner
# daemon (paperclip-runnerd) from the Paperclip release that the server runs.
# Bump this digest together with the base image of the server
# (paperclip-linear's Dockerfile). The index digest resolves to the build
# platform, linux/amd64.
FROM ghcr.io/paperclipai/paperclip:2026.1117.0@sha256:bdf38d10544dc6c831e16dc027f23ad586353ef3be1a1b2c6979e63b956aceb1 AS paperclip

# Debian 13: Paperclip's own runner needs glibc 2.39 or newer on the
# execution host (PAPERCLIP_RUNNER_MINIMUM_GLIBC_VERSION in
# packages/shared/src/agent-runner.ts). Debian 12 has 2.36.
FROM node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0

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
      netcat-openbsd \
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
# A slot cap in front of pi (pi-slot.sh): at most `max-concurrent` pi runs at
# once, because the pi agents share one gateway key.
COPY pi-slot.sh /tmp/pi-slot.sh
RUN real=$(readlink -f /usr/local/bin/pi) \
 && test -x "$real" \
 && rm /usr/local/bin/pi \
 && sed "s|@PI_REAL@|$real|" /tmp/pi-slot.sh >/usr/local/bin/pi \
 && chmod 755 /usr/local/bin/pi \
 && rm -rf /tmp/pi-slot.sh /tmp/pi-slots \
 && ! grep -q @PI_REAL@ /usr/local/bin/pi \
 && pi --version \
 && rm -rf /tmp/pi-slots /root/.pi
# web_search, the image's own pi extension (DIL-994): web search through the
# cluster's SearXNG. Root-owned and read-only to the agent user. The wrapper
# (pi-slot.sh) loads it with `-e` and adds it to Paperclip's `--tools` list.
# The tests run here: CI only builds this image, so a failed test fails the
# build. They load it through pi's own loader, run it against a stub SearXNG
# (format, caps, errors, abort and timeout), and start pi through the wrapper
# offline to check that web_search is an active tool. pi-slot.test.sh tests
# the wrapper's argument changes on a copy of the installed wrapper whose real
# pi is a stub that prints its arguments. COPY --chmod also gives the new
# directory mode 644, so the RUN sets it to 755.
COPY --chown=0:0 --chmod=644 pi-extensions/web-search.ts /opt/pi-extensions/web-search.ts
COPY pi-extensions/web-search.test.mjs pi-slot.test.sh /tmp/web-search-test/
RUN chmod 755 /opt/pi-extensions \
 && test "$(stat -c '%a %U %G' /opt/pi-extensions /opt/pi-extensions/web-search.ts)" = "$(printf '755 root root\n644 root root')" \
 && cd /tmp/web-search-test \
 && printf '#!/bin/sh\nfor a do printf "[%%s]" "$a"; done\necho\n' >argv-stub \
 && sed "s|^real=.*|real=/tmp/web-search-test/argv-stub|" /usr/local/bin/pi >pi-under-test \
 && chmod 755 argv-stub pi-under-test \
 && grep -qx 'real=/tmp/web-search-test/argv-stub' pi-under-test \
 && sh pi-slot.test.sh ./pi-under-test /opt/pi-extensions/web-search.ts \
 && PI_PACKAGE_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" \
    WEB_SEARCH_EXTENSION=/opt/pi-extensions/web-search.ts \
    node --test web-search.test.mjs \
 && cd / \
 && rm -rf /tmp/web-search-test /tmp/pi-slots /root/.pi
# web-fetch (DIL-994): reads one web page through the cluster's web-fetch
# service and prints it as Markdown. It is a command, not a pi tool, so pi
# agents (bash) and Claude Code agents (Bash) use the same one. Root-owned and
# read-only to the agent user. The tests run the installed command against a
# stub service: success, truncation, each error code, a service that is down
# or hangs, bad URLs and options, and --json.
COPY --chown=0:0 --chmod=755 web-fetch /usr/local/bin/web-fetch
COPY web-fetch.test.mjs /tmp/web-fetch-test/
RUN test "$(stat -c '%a %U %G' /usr/local/bin/web-fetch)" = '755 root root' \
 && grep -q '"http://web-fetch.aitools.svc.cluster.local:8080/fetch"' /usr/local/bin/web-fetch \
 && WEB_FETCH_BIN=/usr/local/bin/web-fetch node --test /tmp/web-fetch-test/web-fetch.test.mjs \
 && rm -rf /tmp/web-fetch-test

# Google Antigravity's ACP server (DIL-963), for gemini_local agents with
# agentCommand `agy-acp` (runner/agy-acp.sh). The URL and the archive sha256
# are the linux-x64 pins in Paperclip 2026.1117.0
# (packages/paperclip-runner/antigravity-distributions.json). Paperclip marks
# this build inventory-only and does not run it itself. The server links only
# against glibc, and localharness_external is static. Unpacked, it is about
# 1 GB. The build does not start it: its tcmalloc aborts at start when it
# cannot count the CPUs, as in the BuildKit sandbox. It starts in a container.
ARG AGY_ACP_VERSION=1.4.3
ARG AGY_ACP_SHA256=0634ce5306ba92c932945455e7a83fda78e2d99c33fa8aa6ee0566206a382714
COPY agy-acp.sh /tmp/agy-acp.sh
RUN dir="/opt/antigravity/${AGY_ACP_VERSION}" \
 && curl -fsSL -o /tmp/agy.zip \
      "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-${AGY_ACP_VERSION}-linux-x86_64.zip" \
 && echo "${AGY_ACP_SHA256}  /tmp/agy.zip" | sha256sum -c - \
 && mkdir -p "$dir" \
 && unzip -q /tmp/agy.zip -d "$dir" \
 && rm /tmp/agy.zip \
 && chmod -R go-w,a+rX /opt/antigravity \
 && test -x "$dir/agy_acp_server.par" \
 && test -x "$dir/localharness_external" \
 && sed "s|@AGY_REAL@|$dir/agy_acp_server.par|" /tmp/agy-acp.sh >/usr/local/bin/agy-acp \
 && chmod 755 /usr/local/bin/agy-acp \
 && rm /tmp/agy-acp.sh \
 && ! grep -q @AGY_REAL@ /usr/local/bin/agy-acp
# The filter in front of the server that removes the HTTP and SSE MCP
# servers (runner/agy-acp, DIL-1006). Its tests run here, so a failed test fails the
# build.
COPY agy-acp /usr/local/lib/agy-acp
RUN cd /usr/local/lib/agy-acp \
 && node --test mcp-filter.test.mjs \
 && rm mcp-filter.test.mjs \
 && chmod -R go-w,a+rX /usr/local/lib/agy-acp
# The token broker for agy-acp (runner/agy-broker), run in its own pod from
# this image. Its tests run here: CI only builds this image, so a failed test fails
# the build.
COPY agy-broker /usr/local/lib/agy-broker
RUN cd /usr/local/lib/agy-broker \
 && node --test agy-broker.test.mjs \
 && rm agy-broker.test.mjs \
 && chmod -R go-w,a+rX /usr/local/lib/agy-broker

# The provider pack (about 2.7 GB) and the daemon, root-owned and not writable
# by the agent user. Only then does the daemon report the pack as protected
# ("immutable"), and a protected pack keeps working across compatible server
# releases (Paperclip 2026.1117.0). The server finds both at these paths and
# uses the daemon only when its sha256 equals the server's own copy.
# Only entries with group or other write are changed: a recursive chmod would
# copy the whole pack into a new layer. The check runs as the agent user,
# because root can write any file and so never sees the pack as protected.
COPY --from=paperclip --chown=0:0 /opt/paperclip-runner/provider-pack /opt/paperclip-runner/provider-pack
COPY --from=paperclip --chown=0:0 --chmod=755 /app/server/dist/vendor/paperclip-runner/bin/paperclip-runnerd /opt/paperclip-runner/bin/paperclip-runnerd
RUN find /opt/paperclip-runner -perm /022 ! -type l -exec chmod go-w {} + \
 && setpriv --reuid=20100 --regid=20100 --clear-groups \
      /opt/paperclip-runner/bin/paperclip-runnerd --build-metadata \
      --provider-pack-root /opt/paperclip-runner/provider-pack >/tmp/runnerd.json \
 && jq -e '.prpTransportModes | index("dial_wss") != null' /tmp/runnerd.json >/dev/null \
 && jq -e '.providerPacks[0].immutable == true' /tmp/runnerd.json >/dev/null \
 && jq -e '.providerPacks[0].manifest.payload.target == {"platform": "linux", "architecture": "x64"}' \
      /tmp/runnerd.json >/dev/null \
 && rm /tmp/runnerd.json

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
COPY nix-store-check.py /usr/local/bin/nix-store-check
# Record a fresh Nix database's schema for the start-time check, and test the
# hash formats it relies on against this Nix (a throwaway store).
RUN /usr/local/bin/nix-store-check --build /tmp/nix-store-check \
 && rm -rf /tmp/nix-store-check
# The agent user: the base image's node user, moved off UID/GID 1000, which is
# usually the first login user on the host whose disk backs the volumes.
# 20100 is outside the usual ranges for system, login, subordinate (100000+)
# and nixbld (30000+) IDs.
# The login shell is dash, not bash: sshd runs every command through it, and
# bash then runs ~/.bashrc first. Every run can write the home, so a profile
# could change commands that must not read one, such as the sandbox-ssh
# driver's own housekeeping. `dash -c` reads no file. Commands that source the
# profiles themselves still read them: Paperclip's ssh driver and the
# agent commands of sandbox-ssh do.
RUN groupmod -g 20100 node \
 && usermod -u 20100 -g 20100 -s /bin/sh node \
 && test "$(id -u node):$(id -g node)" = 20100:20100 \
 && test "$(getent passwd node | cut -d: -f7)" = /bin/sh
# The mount point for the store volume; owned by the agent user so a local
# `docker run` without the volume works too.
RUN mkdir -m 755 /nix && chown 20100:20100 /nix

# env/printenv print variable names only when listing (env-names.sh); running
# a command through env is unchanged. They live in their own directory
# (PAPERCLIP_SHIM_DIR, profile.sh), linked from /usr/local/bin, so a dev shell
# that puts its own coreutils first on PATH can put them back in front. The
# build checks the listing, pass-through and option-parsing paths.
COPY --chmod=755 env-names.sh /usr/local/lib/paperclip-shims/env
COPY --chmod=755 printenv-names.sh /usr/local/lib/paperclip-shims/printenv
RUN ln -s /usr/local/lib/paperclip-shims/env /usr/local/bin/env \
 && ln -s /usr/local/lib/paperclip-shims/printenv /usr/local/bin/printenv \
 && SHIM_TEST="$(printf 'secret\nline')" \
 && export SHIM_TEST \
 && e=/usr/local/bin/env \
 && $e | grep -qx SHIM_TEST \
 && ! $e | grep -q secret \
 && ! $e | grep -qx line \
 && [ "$($e A=ok sh -c 'echo "$A"')" = ok ] \
 && [ "$($e -i B=ok /bin/sh -c 'echo "$B"')" = ok ] \
 && [ "$($e -iu X C=ok /bin/sh -c 'echo "$C"')" = ok ] \
 && [ "$($e -vC / sh -c pwd 2>/dev/null)" = / ] \
 && [ "$($e -vS'sh -c pwd' 2>/dev/null)" = "$(pwd)" ] \
 && [ "$($e --uns=HOME sh -c 'echo "${HOME:-none}"')" = none ] \
 && [ "$($e --ch / sh -c pwd)" = / ] \
 && $e -0u HOME | grep -qx SHIM_TEST \
 && ! $e -0u HOME | grep -q secret \
 && $e --version | grep -q coreutils \
 && { $e --bogus >/dev/null 2>&1; [ $? -eq 125 ]; } \
 && [ "$(/usr/local/bin/printenv SHIM_TEST)" = "SHIM_TEST set" ] \
 && ! /usr/local/bin/printenv NOT_SET_HERE >/dev/null \
 && /usr/local/bin/printenv | grep -qx SHIM_TEST \
 && ! /usr/local/bin/printenv | grep -q secret \
 && [ "$(sh -lc 'command -v env')" = /usr/local/bin/env ]
COPY sshd_config /etc/ssh/sshd_config
# git over SSH to GitHub on port 443, with pinned host keys; the deploy key
# comes from the deployment (/run/secrets/git/skrap/key).
# In a run, through the egress proxy (ssh-proxy-connect, DIL-888).
COPY ssh_config_github.conf /etc/ssh/ssh_config.d/github.conf
COPY --chmod=755 ssh-proxy-connect.sh /usr/local/bin/ssh-proxy-connect
COPY github_known_hosts /etc/ssh/github_known_hosts
COPY gitconfig /etc/gitconfig
# ssh-proxy-connect, with a stub netcat that prints its arguments: direct
# without a proxy, a CONNECT tunnel with https_proxy and with HTTPS_PROXY
# only, and for a proxy URL with credentials exit code 64 without running
# netcat.
RUN sh -n /usr/local/bin/ssh-proxy-connect \
 && printf '#!/bin/sh\necho "$*"\n' >/tmp/nc-stub && chmod 755 /tmp/nc-stub \
 && [ "$(/usr/bin/env -u https_proxy -u HTTPS_PROXY SSH_PROXY_CONNECT_NC=/tmp/nc-stub \
        ssh-proxy-connect ssh.github.com 443)" = "-w 15 ssh.github.com 443" ] \
 && [ "$(/usr/bin/env -u HTTPS_PROXY https_proxy=http://proxy.test:3128/ SSH_PROXY_CONNECT_NC=/tmp/nc-stub \
        ssh-proxy-connect ssh.github.com 443)" = "-w 15 -X connect -x proxy.test:3128 ssh.github.com 443" ] \
 && [ "$(/usr/bin/env -u https_proxy HTTPS_PROXY=http://proxy.test:3128 SSH_PROXY_CONNECT_NC=/tmp/nc-stub \
        ssh-proxy-connect ssh.github.com 443)" = "-w 15 -X connect -x proxy.test:3128 ssh.github.com 443" ] \
 && { out=$(/usr/bin/env -u HTTPS_PROXY https_proxy=http://u:p@proxy.test:3128 SSH_PROXY_CONNECT_NC=/tmp/nc-stub \
        ssh-proxy-connect ssh.github.com 443 2>/dev/null); rc=$?; \
      [ "$rc" -eq 64 ] && [ -z "$out" ]; } \
 && rm /tmp/nc-stub \
 && /usr/bin/nc.openbsd -h 2>&1 | grep -q -- '-X proxy_protocol'
RUN grep -q '^Include /etc/ssh/ssh_config.d/\*.conf' /etc/ssh/ssh_config \
 && ssh -G github.com | grep -qx 'proxycommand /usr/local/bin/ssh-proxy-connect %h %p' \
 && ssh -G github.com | grep -qx 'serveraliveinterval 10' \
 && ssh -G github.com | grep -qx 'serveralivecountmax 3' \
 && ssh -G ssh.github.com | grep -qx 'proxycommand /usr/local/bin/ssh-proxy-connect %h %p' \
 && ssh -G ssh.github.com | grep -qx 'port 443' \
 && ssh -G ssh.github.com | grep -qx 'hostkeyalias github.com' \
 && ssh -G ssh.github.com | grep -qx 'stricthostkeychecking true' \
 && ssh -G github.com | grep -qx 'port 443' \
 && ssh -G github.com | grep -qx 'hostname ssh.github.com' \
 && ssh -G github.com | grep -qx 'hostkeyalias github.com' \
 && ssh -G github.com | grep -qx 'stricthostkeychecking true'
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

# sshd runs as the image's node user, so it can only ever log that user in.
# Host and authorized keys are mounted from a Secret at /keys and copied into
# place by the entrypoint.
USER 20100:20100
WORKDIR /home/node
EXPOSE 2222
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
