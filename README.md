# rustguac

[![CI](https://github.com/sol1/rustguac/actions/workflows/ci.yml/badge.svg)](https://github.com/sol1/rustguac/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/sol1/rustguac)](https://github.com/sol1/rustguac/releases/latest)
[![License](https://img.shields.io/github/license/sol1/rustguac)](LICENSE)
[![Docker](https://img.shields.io/docker/pulls/sol1/rustguac)](https://hub.docker.com/r/sol1/rustguac)

> **Fork notice** — This is a personal fork of [sol1/rustguac](https://github.com/sol1/rustguac) maintained by [@pletch](https://github.com/pletch), with additional fixes and features layered on top of upstream **v1.9.10** (see [Fork changes](#fork-changes)). Badges and install instructions below still point at the upstream project; for canonical releases and commercial support, use the upstream repository.

A lightweight Rust replacement for the Apache Guacamole Java webapp. Browser-based SSH, RDP, VNC, SPICE, Proxmox VE consoles, web browsing, and VDI desktop containers through [guacd](https://github.com/apache/guacamole-server).

No Java. No Tomcat. Single binary + guacd.

## Fork changes

This fork layers the following on top of upstream **v1.9.10**. Everything here
is in `main-fork`; the guacd-side changes live in `patches/` and are applied by
the build scripts.

### RDP H.264 passthrough

Upstream ships AVC420-only passthrough. This fork reworks it substantially.

- **AVC444 support** (`patches/004-h264-passthrough.patch`) — both views of an
  AVC444 picture are forwarded and the main one drawn, so Windows hosts can use
  **hardware** H.264 encoding, which requires `AVC444ModePreferred=1`. Upstream
  forces `GfxAVC444` off to sidestep the colour corruption this used to cause.
  Both views are decoded and combined, giving full 4:4:4 chroma (see
  [`docs/rdp-h264.md`](docs/rdp-h264.md)).
- **4:4:4 chroma reconstruction** — the auxiliary view of an AVC444 picture is
  not an image: its planes carry the chroma samples the main view's 4:2:0
  subsampling discarded, packed by position. A WebGL2 shader
  (`static/guac/Yuv444.js`) unpacks both MS-RDPEGFX chroma layouts and converts
  to RGB in a single pass, and inverts the encoder's chroma filter to recover
  the one sample per 2x2 block that neither view carries. This matters most for
  text, since ClearType antialiases glyphs with per-pixel colour fringes —
  precisely what 4:2:0 averages away. Frames are copied in whatever pixel
  format the decoder produced, as hardware decoders generally give NV12 and
  software ones I420. Falls back to 4:2:0 on its own where WebGL2 is missing,
  the GL context is lost, or the frame carries no readable planes.
- **Ordered drawing** — the `h264` instruction gains a `<view>` field and
  trailing region rects, and frames are painted through the display's task
  queue (`Display.drawH264`) rather than straight from the decoder's output
  callback. Upstream draws on completion, so on a server mixing H.264 with
  other codecs a late frame repaints stale video over newer content.
- **Frame lifetime** — ordered drawing defers the paint, so a decoded frame is
  snapshotted to a canvas and closed before its draw task runs. Holding a
  `VideoFrame` across a promise exhausts the hardware decoder's output-surface
  pool as soon as the display queue falls behind, which shows up as brief video
  freezes. (Upstream draws straight from the output callback, so it has no
  frame to hold open — and no frame ordering either.)
- **Recovery from a terminal decode error** — the decoder is rebuilt and frames
  held until the next keyframe. Upstream decrements its counter and logs, but
  the `VideoDecoder` is closed by then and `decode()` returns early forever
  after, so the session stays blank until the user reconnects.
- **Decode pipeline depth** — upstream's sync gate waits for `pendingDecodes`
  to reach zero, serializing network RTT against decode time on every frame.
  This fork allows a bounded depth of 2 so the two overlap, with a 200ms
  safety timeout and a rate-limited warning, since logging from a struggling
  decoder makes the latency it reports worse.
- **Codec configuration** — the decoder is configured as `avc1.640029` (High,
  4.1) with `hardwareAcceleration: 'prefer-hardware'`, matching what xrdp and
  Windows actually send. Upstream declares `avc1.42001f` (Baseline, 3.1).
- **Survives an RDPGFX reconnect** — the SurfaceCommand and CapsConfirm
  wrappers are installed once, only for connections with H.264 enabled, and
  each is guarded on its own callback. They are reinstalled when the channel is
  re-opened, because FreeRDP restores its own handlers on a reconnect — which
  xrdp triggers at the login resize, so without this a session delivered one
  keyframe and then went silent.
- **Recording playback** — the recordings player loads the H.264 decoder and
  the 4:4:4 shader, so sessions recorded with passthrough replay as video
  instead of a black display.
- **Runtime overrides for the chroma path** — `h264Chroma444` (off falls back
  to 4:2:0) and `h264ChromaFilter` (off, or a 0-255 threshold; default 30),
  settable as a window global, query param, or `localStorage` key.

Measured with 1080p video playing, guacd session CPU over 30s:

| | decode + re-encode | passthrough |
|---|---|---|
| xrdp (AVC420) | ~100% of a core | **2.0%** |
| Windows 11 (AVC444) | 90.6% of a core | **2.1%** |

### Display / HiDPI

- **Per-connection Native Resolution** — requests the framebuffer in the
  browser's physical pixels rather than its CSS pixels, so text stays sharp on
  a high-DPI display. Off by default and set per entry, because it is only safe
  where the target also scales its own UI.
- **RDP DPI scaling** (`patches/011-rdp-dpi-scaling.patch`) — a `desktop-scale`
  parameter asking the server to render its desktop at a matching DPI, which
  guacd otherwise cannot do at all: it pins `DesktopScaleFactor` to zero, and
  its `dpi` parameter only rescales the requested dimensions. The scale is
  re-sent on every display update, since a monitor layout carrying zeroes
  resets the session to 100%.
- **Configurable SSH terminal font size** with a **HiDPI fix** — SSH text no
  longer renders oversized on high-DPI displays (SSH DPI pinned to a 96
  baseline; the client auto-scales).

### Connections / sessions

- **Per-entry Wake-on-LAN** — sends a magic packet via guacd and polls the
  target before connecting (SSH/RDP/VNC); configurable MAC, broadcast address,
  UDP port, and wait time.
- **Jump-host-aware network allowlist** — with a jump chain configured, the
  per-protocol CIDR allowlist is checked against hop 0, the only host rustguac
  itself dials. The target's name is resolved by the last hop, so resolving it
  locally rejected valid bastion-only names outright.

### OIDC

- **Lazy provider discovery with retry** — if the OIDC provider (e.g. Authelia)
  is unreachable at startup, SSO stays enabled instead of being silently
  disabled until restart; provider metadata is discovered on the first login
  and cached, so SSO recovers automatically once the provider comes up. The
  login page reflects live availability: while the provider is unreachable the
  SSO button is disabled with a "temporarily unavailable" notice and the page
  polls until it recovers (re-enabling the button without a reload).
- **Callback diagnostics** — on a state-cookie mismatch, logs whether the
  cookie was absent vs. present-but-different plus `Host`/`X-Forwarded-*`
  headers, to diagnose reverse-proxy cookie issues.

### UI / admin

- **Onboarding modal close button** to skip the welcome tour entirely.

### Docs and tooling

- [`docs/rdp-h264.md`](docs/rdp-h264.md) — H.264 passthrough setup, including
  the non-obvious Windows requirement that the *"Use WDDM graphics display
  driver for Remote Desktop Connections"* policy be **Disabled** or hardware
  encoding never engages.
- [`docs/upstream-h264-issue.md`](docs/upstream-h264-issue.md) — draft write-up
  for upstream: why `GfxAVC444 = FALSE` makes Windows hosts negotiate no H.264
  at all, and why the server-side decode still runs on every frame.
- [`docs/xrdp-dpi-scaling.md`](docs/xrdp-dpi-scaling.md) — what an xrdp patch
  would need in order to act on the DPI scale factor it already parses,
  validates and then discards.
- [`BUILD-CONTAINER.md`](BUILD-CONTAINER.md) — building, installing and
  updating guacd and rustguac on a deployment container, against the pinned
  guacamole-server commit the patches are verified on.
- **Installer**: guacd's environment lives in `/opt/rustguac/guacd.env`, which
  is created once and never overwritten, so `GUACD_LOG_LEVEL` survives a
  reinstall — the unit files themselves are rewritten every run. The installer
  also warns about existing systemd drop-ins, which silently override the unit
  it just wrote.
- **Client-side H.264 diagnostics** — `rustguacFindBlack()` locates black
  regions on the display, `rustguacDumpDraws()` reports what painted a given
  pixel from a ring of recent draws, and `rustguacDumpBlack()` does both in one
  call; `?debug=nofit` suppresses resize requests so opening DevTools cannot
  repaint the region being inspected.
- `contrib/measure-guacd-cpu.sh`, `contrib/setup-rdp-performance.ps1`.

### Merged upstream

These started here and now ship in upstream rustguac, so they are no longer
fork-specific:

- **AVC420-only H.264 passthrough** — worked around AVC444 colour corruption on
  Windows hosts by disabling AVC444 outright (upstream as of v1.8.1). This fork
  has since superseded it by handling AVC444 properly, as described above.
- **Per-entry RDP desktop appearance** — configurable wallpaper, theming, and
  full-window drag (upstream as of v1.8.1).
- **TCP_NODELAY** — Nagle's algorithm disabled on rustguac's TCP sockets.
- **Local-time timestamps** on the admin page.
- **Rendering fixes ported from `fixes-1.6.0`** — terminal OSC-consume and RDP
  mod-16 dirty-region guacd patches.

## Architecture

```
Browser (HTML/JS)
    |
    | WebSocket over HTTPS
    v
rustguac (Rust, axum)
    |
    | TLS (Guacamole protocol)
    v
guacd (C, from guacamole-server)
    |
    +---> SSH server
    +---> RDP server
    +---> VNC server
    +---> SPICE server (libvirt/QEMU displays)
    +---> Proxmox VE VM console (SPICE via the PVE spiceproxy API)
    +---> Xvnc + Chromium (web browser sessions)
    +---> Docker container + xrdp (VDI desktop sessions)
```

## Features

### Session types

| Type | Description |
|------|-------------|
| **SSH** | Browser-based terminal with password, private key, or ephemeral keypair auth. SFTP file transfer. |
| **RDP** | Windows/Linux RDP with auto-fit resize, Kerberos NLA, RemoteApp/RAIL, H.264 passthrough, GFX pipeline. |
| **VNC** | Connect to any VNC server (KVM/IPMI consoles, remote desktops, VM displays). |
| **SPICE** | Direct SPICE displays (libvirt/QEMU consoles) with TLS, CA verification, certificate-subject pinning, and SPICE-proxy support. |
| **Proxmox VE** | VM consoles brokered through the Proxmox API. One-time SPICE tickets fetched just-in-time at connect (only the API token is stored), node auto-detected from the VM ID, and SSH-tunnel aware. |
| **Web** | Headless Chromium on Xvnc with native autofill, domain allowlisting, login script automation. |
| **VDI** | Ephemeral Docker desktop containers per user. Persist after disconnect, auto-cleanup on idle. |

### Security & authentication

- **OIDC single sign-on**: Authentik, Google, Okta, Keycloak, or any OpenID Connect provider
- **4-tier role system**: admin, poweruser, operator, viewer with OIDC group mapping
- **API key auth**: SHA-256 hashed keys with IP allowlists and expiry
- **Vault-backed connections**: credentials in HashiCorp Vault or OpenBao KV v2, never reach the browser (see [Requirements](#requirements))
- **TLS everywhere**: HTTPS for clients, TLS between rustguac and guacd
- **CIDR allowlists**: per-protocol network restrictions for session targets
- **Per-entry clipboard control**: disable copy and/or paste for data loss prevention
- **Rate limiting**: per-IP, per-endpoint via tower_governor
- **Session recording**: Guacamole format with playback UI, disk rotation, per-entry limits

### Connectivity

- **Multi-hop SSH tunnels**: chain jump hosts/bastions to reach isolated networks (all session types, including the Proxmox API and console hops)
- **Session sharing**: share tokens for read-only or collaborative access
- **Headless API integration**: create a session over the REST API and hand a browser a ready-to-open URL via a single-use WebSocket ticket, with no OIDC login and no API key in the browser (see [Connecting to a session](docs/api.md#connecting-to-a-session))
- **Encrypted file transfer**: LUKS-encrypted per-session drive storage (RDP), SFTP (SSH)
- **Credential variables**: shared credentials across connections entries

### VDI desktop containers

- **Docker-based**: one container per user, deterministic naming, BYO image
- **Persist after disconnect**: reconnect to the same desktop within idle timeout
- **Logout detection**: desktop logout stops the container, tab close preserves it
- **Session thumbnails**: live preview in the connections, click to reconnect
- **Persistent home directories**: bind-mounted user data survives container restarts
- **Per-entry resource limits**: CPU, memory, idle timeout per connections entry
- **VdiDriver trait**: extensible for downstream forks (Nomad, Proxmox, cloud)

### UI

- **Connections** with folder-based organisation and OIDC group access control
- **Active Sessions** section with live thumbnail previews
- **Session ended overlay** with Reconnect/Close buttons
- **Clipboard panel controls** (Home + Fullscreen)
- **8 built-in themes** with CSS gradient backgrounds, or configure your own
- **Reports page** with session analytics, history, and CSV export

## Requirements

| Component | Status | Notes |
|-----------|--------|-------|
| guacd | Bundled | Built from `apache/guacamole-server`, ships in the .deb and Docker image. No separate install. |
| **Vault or OpenBao** | **Required for the Connections UI** | Stores connection entries and credentials server-side. Without it the Connections page is unavailable and users can only run ad-hoc sessions via the API. Use [`contrib/vault-quickstart.sh`](contrib/vault-quickstart.sh) for one-command setup (auto-detects `vault` or `bao`, supports `--dev` and `--local` modes). |
| OIDC provider | Optional | For SSO. API-key auth works on its own. Authentik/Google/Okta/Keycloak/JumpCloud all tested. |
| Docker | Optional | Only needed for VDI desktop containers. |

### Supported browsers

The client runs in any modern browser (Chrome, Firefox, Edge, Safari, Chromium, Brave). One caveat applies only to **H.264-accelerated RDP**, which is opt-in per connection (the per-entry H.264 toggle, off by default):

- **Standard connections** (SSH, RDP, VNC, web sessions, VDI) work in every modern browser.
- **H.264-accelerated connections** need a browser that can decode H.264 through the WebCodecs API. **Chrome** and **Firefox** work. Open-source **Chromium** and **Brave** builds without the bundled H.264 codec, and older Safari, render a blank display on those connections. Leave H.264 off (the default) for universal browser support, or use Chrome or Firefox where it is enabled.

## Quick start

### Debian 13 (.deb)

Pre-built packages for amd64 and arm64 are available from [Releases](https://github.com/sol1/rustguac/releases):

```bash
sudo apt install ./rustguac_*.deb
/opt/rustguac/bin/rustguac --config /opt/rustguac/config.toml add-admin --name admin
sudo systemctl enable --now rustguac
```

### Docker

```bash
docker pull sol1/rustguac:latest
docker run -d -p 8089:8089 sol1/rustguac:latest
```

For VDI support, mount the Docker socket:

```bash
docker run -d -p 8089:8089 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add $(getent group docker | cut -d: -f3) \
  sol1/rustguac:latest
```

### Other distributions

Pre-built packages are provided for Debian 13. For other distributions, build from source:

```bash
sudo ./install.sh
```

See the [Installation guide](docs/installation.md) for full details including Docker Compose, TLS setup, and development builds.

### VDI setup

VDI requires Docker on the host:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker rustguac
sudo systemctl restart rustguac
```

Add `[vdi]` to your config and create a VDI entry in the connections. See [VDI Desktop Containers](docs/vdi.md) for image requirements and configuration.

## Documentation

### Getting started
- [Installation](docs/installation.md): Debian packages, Docker, bare-metal, development builds
- [Configuration](docs/configuration.md): TOML config reference with all sections
- [Deployment Guide](docs/deployment-guide.md): step-by-step production setup

### Features
- [Roles & Access Control](docs/roles-and-access-control.md): OIDC, roles, group mappings, API tokens
- [Web Browser Sessions](docs/web-sessions.md): autofill, domain allowlisting, login scripts
- [VDI Desktop Containers](docs/vdi.md): Docker desktops, image requirements, persistent homes
- [RDP Video Performance](docs/rdp-video-performance.md): H.264 passthrough, GFX pipeline, xrdp tuning
- [Credential Variables](docs/credential-variables.md): shared credentials across entries
- [Reports](docs/reports.md): session analytics, history, CSV export

### Integration & reference
- [Integrations](docs/integrations.md): Vault, LUKS drives, SSH tunnels, Kerberos, HAProxy, Knocknoc
- [NetBox](docs/netbox.md): connections sync via custom fields and webhooks
- [Security](docs/security.md): TLS, rate limiting, headers, audit logging, hardening
- [API Reference](docs/api.md): REST API endpoints, the session connection flow, and headless ws-ticket integration
- [Migration from Apache Guacamole](docs/migration.md): MySQL/MariaDB to Vault

## Commercial support

Commercial support for rustguac is available from [Sol1](https://www.sol1.com.au).

## License

Apache License 2.0. See [LICENSE](LICENSE) for details.
