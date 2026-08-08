---
description: Manage self-hosted sshd devboxes on bourbon (Windows box, Rancher Desktop/containerd/nerdctl, reached via Tailscale SSH). Use whenever the user wants to create, mount into, or auto-provision a devbox from a devcontainer.json — our DIY equivalent of GitHub Codespaces, without GitHub.
argument-hint: [create|list|start|stop|rm|ssh|logs] [name] [--mount host:container]
---

# bourbon devbox management

## The setup

`bourbon` is a Windows machine reached over Tailscale SSH (`ssh bourbon`, user `cafe`).
It runs **Rancher Desktop** with the **containerd/nerdctl** engine (not moby/dockerd) —
there is no `docker` daemon. Containers are managed via `rdctl shell nerdctl ...`,
which hops: this Mac → bourbon (Windows, cmd.exe) → `rdctl shell` → Rancher's WSL
Linux VM (Alpine-based, `rancher-desktop-wsl-distro`) → nerdctl → containerd
(`/run/k3s/containerd/containerd.sock`).

**The tool: `/Users/kyle/.local/bin/devctl`.** Always use it instead of raw
`ssh bourbon 'rdctl shell nerdctl ...'` calls — it already handles the quoting
minefield below. Canonical backup lives at `scripts/devctl` in this skill's repo
(`github.com/TuanKietTran/claude-skills`) — if you edit `~/.local/bin/devctl`,
copy the change back here and commit, they will drift otherwise.

```
devctl create <name> [--mount <host-path>[:<container-path>]]
devctl list
devctl start|stop|rm|ssh|logs <name>
```

- `<name>` → container `<name>-devbox`, SSH host `<name>-devbox` (auto-added to
  `~/.ssh/config` as `HostName localhost` / assigned port / `ProxyJump cafe@bourbon`).
- Base image: `python:3.14-slim` + openssh-server/git/build-essential/curl/sudo/tmux,
  non-root user `kyle` with passwordless sudo, pubkey-only SSH.
- `--mount` bind-mounts a path **as seen from bourbon's Rancher Desktop Linux VM**
  (e.g. `/mnt/c/chatgpt-orchestrator` for `C:\chatgpt-orchestrator` — bourbon's `C:`
  is mounted at `/mnt/c` inside that VM). Container path defaults to
  `/home/kyle/workspace`.

## devcontainer.json auto-provisioning (the Codespaces-equivalent bit)

If `--mount` is given and `<container-path>/.devcontainer/devcontainer.json` exists
at create time, `devctl` **automatically**:

1. Extracts `postCreateCommand` (tolerant of `//` and `/* */` comments — string-aware,
   so it won't corrupt a value containing a URL like `https://...`; see gotcha below).
2. Runs it inside the *same* sshd container, as root (so `apt-get` etc. just work),
   with `HOME=/home/kyle` (so `curl | sh`-style installers like `uv`'s land under
   kyle's home, not root's).
3. `chown -R kyle:kyle /home/kyle` afterward, so everything the command created
   is immediately usable by `kyle` over SSH — no manual permission fixing.

**Deliberate scope limit:** only `postCreateCommand` is honored. `image`, `build`,
and `features` in `devcontainer.json` are **ignored** — the devbox always uses
devctl's own sshd base image, because SSH access is the whole point of this setup
and an arbitrary devcontainer image won't have sshd/kyle/sudo wired up. If a
project's devcontainer.json needs a different base image or `features`, that's a
manual Dockerfile edit, not something devctl auto-handles.

This means: one container per devbox, always SSH-reachable, with real project
dependencies installed. Compare to `devcontainer up` (see below) which spins up a
*separate*, non-SSH-reachable container — don't use that for routine dev work now
that devctl has native support.

## Hard-won gotchas (don't re-derive these)

- **`nerdctl inspect <name>` matches images too**, not just containers — a leftover
  image from a prior build makes `devctl create` falsely report "already exists".
  Always use `nerdctl inspect --type container <name>` for existence checks.
- **Quoting survives exactly one round-trip of naive passthrough, no more.** The
  chain is: bash (this Mac) → single `ssh bourbon "<string>"` → Windows cmd.exe →
  `rdctl shell` → Linux VM shell → (optionally) `nerdctl exec` → container shell.
  Anything with pipes, `&&`, quotes, or multi-line content **must** be base64-encoded
  locally and decoded remotely (`echo <b64> | base64 -d | sh`) — see
  `container_exec_script()` in devctl. Don't try to hand-quote through more than one
  hop; it will silently mangle or truncate.
- **A naive `//.*` comment-stripping regex breaks JSON values containing URLs**
  (e.g. `postCreateCommand` with `https://astral.sh/uv/install.sh` gets truncated
  mid-line, corrupting the JSON, causing silent parse failure). devctl's parser is
  string-aware to avoid this — don't regress it back to a naive regex.
- Non-interactive `ssh host 'cmd'` does **not** source `.bashrc`/`.profile` (not a
  login shell). To test something that depends on PATH additions from an installer
  (uv, nvm, etc.), use `ssh host 'bash -lc "..."'`.
- Rancher Desktop's WSL VM has a real `/usr/bin/docker` binary, but no
  `dockerd`/socket — running it fails looking for `/var/run/docker.sock`. There's a
  working shim at `/usr/local/bin/docker` in that VM (`exec nerdctl "$@"`) which
  earlier in PATH, so `docker` commands issued *inside that VM* transparently become
  `nerdctl` calls. This was needed to get `@devcontainers/cli` working there at all.

## Fallback: full devcontainer.json spec compliance via `@devcontainers/cli`

Node/npm and `@devcontainers/cli` are installed inside the Rancher Desktop WSL VM
(`ssh bourbon 'rdctl shell devcontainer --version'`), for cases devctl's lightweight
`postCreateCommand`-only path can't handle (full `features`, lifecycle ordering,
`build` args, etc.):

```
ssh bourbon 'rdctl shell sh -c "devcontainer up --workspace-folder /mnt/c/<project>"'
```

This is spec-correct (same engine as VS Code/Codespaces) but creates a **separate**
container with no sshd/SSH access — only `devcontainer exec`. Treat it as a
one-off validation tool, not the routine workflow. Known gotcha: if the
devcontainer.json sets a custom `workspaceFolder`, also set a matching
`workspaceMount`, or the CLI mounts at its computed default
(`/workspaces/<folder-name>`) while `cwd` points elsewhere, and the container
fails to start with a `chdir` error.

## Debugging primitives

- Raw shell in the Linux VM: `ssh bourbon 'rdctl shell sh -c "<cmd>"'`
- List everything: `ssh bourbon 'rdctl shell nerdctl ps -a --format "{{.Names}}|{{.Status}}|{{.Ports}}"'`
- Exec into a running container: `ssh bourbon 'rdctl shell nerdctl exec <cname> <cmd>'`
- `devctl list` is the friendly version, filtered to `*-devbox` names.
