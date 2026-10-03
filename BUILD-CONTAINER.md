# Building and updating the fork on a container

This document covers building, installing, and **updating** this fork's two
components on a deployment container (Debian 13 / Trixie):

1. **guacd** — the C daemon, built from `apache/guacamole-server` with this
   repo's `patches/` applied.
2. **rustguac** — the Rust binary.

The values here mirror `install.sh` (prefix `/opt/rustguac`, pinned guacd commit
`6719b20d`, configure flags). Running `./install.sh` does all of this in one
shot; the manual steps below are for rebuilding a single component.

> **Pin the commit.** The patches in `patches/` are exported and verified against
> `apache/guacamole-server@6719b20d`. Building against a different commit may
> cause `git apply` to fail. A fresh clone at that commit is the safe path.

---

## 0. Updating an existing install

This fork is maintained as a **rebased linear stack** on top of upstream and is
force-pushed on every sync. That means `git pull` will fail with:

```
fatal: Need to specify how to reconcile divergent branches.
```

That is expected, and none of the three hints `git` offers is the right answer —
merge creates junk commits, and `ff-only` just fails again on the next rewrite.
A deploy checkout should **track** the remote, not reconcile with it:

```bash
cd /path/to/rustguac
git fetch origin
git reset --hard origin/main-fork
```

Idempotent, and survives every force-push. Before resetting, confirm you have no
local work to lose — both of these should print nothing:

```bash
git log --oneline @{u}..HEAD    # local commits not on the remote
git status --short              # uncommitted edits
```

### Then rebuild

The easiest path is to re-run the installer, skipping the apt step:

```bash
cd /path/to/rustguac
./install.sh --no-deps
```

**Does the update need a guacd rebuild, or just the Rust binary?** Check whether
the sync touched the guacd inputs:

```bash
git diff --stat HEAD@{1} HEAD -- patches/ install.sh
```

If `patches/` or `GUACD_COMMIT` changed, guacd **must** be rebuilt — a
rustguac-only rebuild leaves the new binary talking to a stale daemon, which
fails in confusing ways (missing protocols, missing display features) rather
than erroring cleanly. If only `src/` and `static/` changed, section 2 alone is
enough.

> **Stale-source trap.** `install.sh` reuses an existing `../guacamole-server`
> checkout if it finds one beside the repo, instead of cloning fresh. When a
> patch has been *rewritten* upstream (not just added), `git apply --check`
> fails against a tree that still has the old version applied and the script
> **silently skips it** — you get a stale build with no error. If that directory
> exists, delete it before re-running so a fresh clone happens:
>
> ```bash
> rm -rf /path/to/guacamole-server   # only the sibling checkout
> ```
>
> `BUILD_DIR` is `/tmp/rustguac-build-$$` (unique per run), so there is no stale
> build directory to clean up.

### What a reinstall preserves and overwrites

| Path | Reinstall behaviour |
|------|--------------------|
| `/opt/rustguac/config.toml` | **Preserved** — skipped if it already exists |
| `/opt/rustguac/env` | **Preserved** — never written by `install.sh` |
| `/etc/systemd/system/rustguac.service.d/` | **Preserved** — drop-ins are never touched |
| `/opt/rustguac/static/*` | **Overwritten** — intended; this is how new UI ships |
| `/etc/systemd/system/rustguac.service` | **Overwritten** — see the warning below |
| `/etc/systemd/system/rustguac-guacd.service` | **Overwritten** |

> **Never hand-edit `rustguac.service`.** `install.sh` regenerates it with an
> unconditional `cat >`, so any edits are silently lost on the next reinstall.
> The generated unit deliberately has **no `EnvironmentFile=` directive**, so a
> reinstall that wipes a hand-added one shows up as
> `VAULT_SECRET_ID env var required when [vault] is configured` in the journal —
> with SSO still working, because the OIDC secret comes from `config.toml`.
> Use a drop-in instead (section 3).

---

## 1. guacd (with patches)

### Build dependencies

`freerdp3-dev` is **mandatory** — patch `001` exists to make guacd compile
against FreeRDP 3.x. Do not build against FreeRDP 2.
`libspice-client-glib-2.0-dev` (>= 0.38) is required by patch `008` (SPICE).

```bash
apt-get update
apt-get install -y \
  autoconf automake libtool pkg-config make gcc g++ git \
  libcairo2-dev libjpeg-dev libpng-dev libwebp-dev \
  libssh2-1-dev libssl-dev libvncserver-dev \
  libpango1.0-dev libpulse-dev \
  libavcodec-dev libavformat-dev libavutil-dev libswscale-dev \
  libcunit1-dev libtelnet-dev libwebsockets-dev \
  freerdp3-dev libspice-client-glib-2.0-dev uuid-dev
```

### Clone at the pinned commit and apply patches

`REPO` is this fork's checkout (the directory containing `patches/`).

```bash
REPO=/path/to/rustguac

git clone https://github.com/apache/guacamole-server.git /tmp/guacamole-server
cd /tmp/guacamole-server
git checkout 6719b20d

# Apply all patches in numeric order, idempotently.
for p in "$REPO"/patches/*.patch; do
  if git apply --check "$p" 2>/dev/null; then
    echo "applying $(basename "$p")"
    git apply "$p"
  else
    echo "skip (already applied / N/A): $(basename "$p")"
  fi
done
```

Current patch set — see `patches/README.md` for the full description of each:

| Patch | Purpose |
|-------|---------|
| `001-freerdp3-debian13` | Compile against FreeRDP 3.x on Debian 13 |
| `002-kerberos-nla` | Kerberos NLA authentication for RDP |
| `003-null-guard-and-config-h` | `config.h` includes + NULL guards (fixes RDP resize) |
| `004-h264-display-worker` | AVC420 H.264 passthrough via the display worker |
| `005-rdp-resize-dirty-flush` | Black regions after a dynamic RDP resize |
| `007-rdp-disp-mod16` | Green band on the bottom edge (H.264/GFX path) |
| `008-spice-protocol` | Native SPICE protocol support |
| `009-spice-empty-port` | Silence `Invalid port value` on TLS-only SPICE |
| `010-rdp-multimonitor` | RDP multi-monitor via the Display Control channel |

> The loop above skips a patch whose `--check` fails, which is what makes it
> idempotent — but it cannot distinguish "already applied" from "conflicts".
> On a fresh clone at the pinned commit, every patch should print `applying`.
> A `skip` on a fresh clone means a real conflict; investigate before building.

### Configure, build, install

```bash
autoreconf -fi
mkdir -p build && cd build
../configure --prefix=/opt/rustguac \
  --with-ssh --with-vnc --with-rdp --with-spice \
  --without-telnet --without-kubernetes \
  --disable-guacenc --disable-guaclog --disable-guacclip --disable-static
make -j"$(nproc)"
make install            # -> /opt/rustguac/sbin/guacd
```

### Verify FreeRDP plugins

Drive redirection and audio depend on the `libguac-*` FreeRDP plugins being
installed into the FreeRDP plugin dir:

```bash
ls "$(pkg-config --variable=libdir freerdp3)/freerdp3"/libguac* 2>/dev/null \
  && echo "plugins OK" || echo "plugins MISSING"
```

If missing, copy them from the build tree (`install.sh` does this automatically):

```bash
cp -a /tmp/guacamole-server/build/src/protocols/rdp/.libs/libguac-common-svc-client*.so* \
      /tmp/guacamole-server/build/src/protocols/rdp/.libs/libguacai-client*.so* \
      "$(pkg-config --variable=libdir freerdp3)/freerdp3/"
```

### Restart

```bash
systemctl restart rustguac-guacd
```

---

## 2. rustguac (Rust binary)

The Rust binary needs far fewer dependencies than guacd: the crates avoid system
C libraries (`rusqlite` is `bundled`, TLS is rustls rather than OpenSSL). All it
needs is a C compiler (for the bundled SQLite and `ring`) plus the Rust toolchain.

```bash
# Build deps
apt-get install -y build-essential pkg-config curl ca-certificates

# Rust toolchain (installs into the build user's home; no root needed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
. "$HOME/.cargo/env"

# Build
cd /path/to/rustguac
cargo build --release        # -> target/release/rustguac

# Install binary + static assets, then restart
cp target/release/rustguac /opt/rustguac/bin/rustguac
cp -r static/* /opt/rustguac/static/
systemctl restart rustguac
```

> **HTML pages are cached at startup.** rustguac reads the branded pages into
> memory when it starts, so a `static/` change needs a service restart to take
> effect — and `client.html` is compiled into the binary, so it needs a rebuild,
> not just a copy. CSS and JS are served live. Verify what is actually being
> served rather than what is on disk:
>
> ```bash
> curl -s http://localhost:8089/connections.html | md5sum
> md5sum /opt/rustguac/static/connections.html
> ```

---

## 3. Secrets: use a systemd drop-in

`install.sh` generates `rustguac.service` with **no `EnvironmentFile=`
directive** (this is upstream's documented default — see
`docs/configuration.md`). Secrets that are env-only, notably `VAULT_SECRET_ID`,
must be supplied separately. A drop-in lives in a directory `install.sh` never
touches, so it survives every reinstall:

```bash
# 1. The env file
cat > /opt/rustguac/env <<'EOF'
VAULT_SECRET_ID=your-vault-secret-id
OIDC_CLIENT_SECRET=your-oidc-client-secret
EOF
chmod 600 /opt/rustguac/env
chown rustguac:rustguac /opt/rustguac/env

# 2. The drop-in
mkdir -p /etc/systemd/system/rustguac.service.d
cat > /etc/systemd/system/rustguac.service.d/env.conf <<'EOF'
[Service]
EnvironmentFile=/opt/rustguac/env
EOF

systemctl daemon-reload
systemctl restart rustguac
```

Verify:

```bash
systemctl show rustguac -p EnvironmentFiles
journalctl -u rustguac -b --no-pager | grep -iE "vault|error"
```

> `docs/installation.md` claims the service loads `/opt/rustguac/env` via an
> `EnvironmentFile` directive automatically. It does not — that line contradicts
> `docs/configuration.md` and is an upstream doc bug.

---

## 4. Running `install.sh` as root without sudo

`install.sh` requires root (it exits early if `$EUID -ne 0`), but also calls
`sudo -u "$REAL_USER"` to drop privileges for the Rust build. In a container
where you are already root and `sudo` is not installed, `SUDO_USER` is unset so
`REAL_USER=root` — every one of those calls is `sudo -u root`, a no-op wrapper
that fails only because the binary is missing.

Simplest fix, and the one that keeps `install.sh` byte-identical to upstream
(important for a rebased fork — every local edit to an upstream file is a
permanent rebase conflict):

```bash
apt-get install -y sudo
```

You likely want `sudo` present anyway: the opt-in encrypted-drive setup writes
`/etc/sudoers.d/rustguac-drive` so the `rustguac` service user can invoke
`cryptsetup`/`mount` at runtime.

---

## 5. Post-update verification

```bash
systemctl restart rustguac          # pulls in guacd via Requires=
systemctl status rustguac rustguac-guacd --no-pager
journalctl -u rustguac -b --no-pager | grep -iE "error|warn"
/opt/rustguac/sbin/guacd -v
```

Confirm the served UI actually changed (see the caching note in section 2).

---

## What the ported patches deliver

These require the **guacd** rebuild in section 1; a rustguac binary rebuild
alone does not deliver them:

- **`007-rdp-disp-mod16`** — rounds RDP display dimensions down to mod-16 to
  eliminate the green band along the bottom edge on H.264/GFX resizes.
- **`010-rdp-multimonitor`** — RDP multi-monitor via the Display Control channel.
- **`008` / `009`** — native SPICE support and its TLS-only port fix, required
  for the SPICE and Proxmox VE console session types.

See `patches/README.md` for the full description of all patches.
