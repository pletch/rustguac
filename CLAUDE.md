# CLAUDE.md — Project state for rustguac

## What this project is

rustguac is a lightweight Rust replacement for the Apache Guacamole Java webapp. It proxies the Guacamole protocol over WebSockets between web browsers and guacd (the C daemon from guacamole-server). Supports SSH, RDP, VNC, web browser sessions (headless Chromium on Xvnc), and VDI desktop containers (Docker).

## Architecture

- **Rust binary** (`rustguac`) — axum web server, session manager, WebSocket proxy
- **guacd** — built from apache/guacamole-server source, handles SSH/VNC/RDP protocol translation
- **Xvnc + Chromium** — spawned per web-browser session, streamed via VNC through guacd
- **Docker** — VDI containers spawned per-user, connected via RDP through guacd

## Key files

- `src/main.rs` — entry point, CLI (clap), server setup
- `src/api.rs` — REST API endpoints (session CRUD, recordings, admin)
- `src/session.rs` — session state machine, SessionManager
- `src/browser.rs` — Xvnc + Chromium process lifecycle (display allocator, per-session profile dirs)
- `src/vdi/mod.rs` — VdiDriver trait, container types (ContainerSpec, ContainerInfo, ManagedContainer)
- `src/vdi/docker.rs` — Docker-based VDI driver (bollard, unix socket, start/reuse/stop)
- `src/guacd.rs` — TCP connection to guacd, Guacamole protocol handshake
- `src/protocol.rs` — Guacamole wire format parser/encoder
- `src/websocket.rs` — WebSocket <-> guacd TCP bridge, recording tee
- `src/config.rs` — TOML config loading with defaults
- `src/auth.rs` — API key auth middleware (SHA-256, IP allowlists, expiry), role system
- `src/oidc.rs` — OIDC authentication (login, callback, logout, group extraction)
- `src/vault.rs` — Vault/OpenBao KV v2 client for connections (AppRole auth, token renewal)
- `src/db.rs` — SQLite admin database (rusqlite, bundled)
- `static/client.html` — Guacamole JS client with auto-scaling display
- `static/connections.html` — Vault-backed connections UI (folder/entry management, connect)
- `static/recordings.html` — recording playback with auto-scaling
- `static/sessions.html` — session management dashboard
- `dev.sh` — development script (build guacd, run, deps)
- `install.sh` — bare-metal Debian 13 installer (systemd services)
- `Dockerfile` — multi-stage build (guacd + rustguac + runtime)

## Configuration

TOML config file (`config.local.toml` for dev, `--config` flag for production). Key settings: `listen_addr`, `guacd_addr`, `recording_path`, `static_path`, `db_path`, `xvnc_path`, `chromium_path`, `display_range_start/end`.

### Vault / Connections

Optional `[vault]` section enables the Vault-backed connections. Connection entries (SSH/RDP/Web) are stored in Vault KV v2 — credentials never touch disk or the browser.

```toml
[vault]
addr = "https://vault.example.com:8200"
mount = "secret"           # KV v2 mount (default)
base_path = "rustguac"     # base path under mount (default)
role_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
# namespace = "my-ns"      # optional, for Vault Enterprise / OpenBao namespaces
# instance_name = "prod-1" # optional, enables instance-scoped entries
```

`VAULT_SECRET_ID` env var provides the AppRole secret ID.

Vault KV v2 path structure:
- `<base_path>/shared/<folder>/<entry>` — shared across all instances
- `<base_path>/instance/<name>/<folder>/<entry>` — instance-specific
- `<folder>/.config` — folder metadata: `{"allowed_groups":["group1"], "description":"..."}`
- `<base_path>/users/<sanitized_email>` — per-user credential variables

#### Multiple Vault backends (DR)

Optional `[vault_shared]` / `[vault_local]` blocks (same keys as `[vault]`) give
the `shared` / `instance` scopes their own Vault so one being down can't take the
other with it. A bare `[vault]` is unchanged (shared+local both alias it). Secret
IDs: `VAULT_SECRET_ID`, `VAULT_SHARED_SECRET_ID`, `VAULT_LOCAL_SECRET_ID`. Each
backend connects/retries/renews independently; a down backend greys that scope in
the UI. Per-credential scope: a credential variable can be stored shared or local
(location = truth), toggled per-row in My Credentials (hidden with a single
Vault); `user_credentials_default_scope` (default `local`) seeds new ones. Split
an existing single-Vault deployment with `rustguac vault-migrate` (copy subtree +
.config, then add the block + restart — routing is single-source, no read
fallback). Implemented on branch `feature/multi-vault-dr` (see project memory).

### OIDC

Optional `[oidc]` section enables OpenID Connect authentication. Key settings: `issuer_url`, `client_id`, `client_secret`, `redirect_uri`. `OIDC_CLIENT_SECRET` env var can override the config value. `groups_claim` (default: "groups") specifies the JWT claim for group memberships. `extra_scopes` requests additional scopes.

If login fails on the callback with "OIDC state cookie mismatch", the callback logs whether the state cookie was absent vs. present-but-different, the cookie names received, and the Host/X-Forwarded-Host/X-Forwarded-Proto headers to help diagnose. One known cause: running the reverse-proxy→rustguac leg over HTTPS (rustguac serving TLS with the proxy doing `tls_insecure_skip_verify`) can drop the auth cookies — serve rustguac over plain HTTP behind the proxy instead (the browser→proxy leg stays HTTPS, so the `Secure` cookies still work).

Provider discovery is **lazy with retry** (`OidcState::client()` in `src/oidc.rs`). `init_oidc` builds the HTTP client (fatal config errors like a bad CA cert here disable SSO) and makes a best-effort eager `discover_async`; if the provider is unreachable at startup the failure is logged as a warning but SSO stays enabled (`OidcEnabled` is `true` as long as `[oidc]` is configured). Metadata is then discovered on the first `/auth/login` (or `/auth/callback`) and cached, so SSO recovers on its own once the provider comes up — no rustguac restart needed. Concurrent cold-start logins share one discovery via a write lock; the OIDC HTTP client has connect/overall timeouts so discovery can't hang.

`/api/auth/status` reports `oidc_available` (provider metadata discovered/cached) separately from `oidc_enabled` (configured). When enabled-but-not-ready it spawns a background `OidcState::client()` to warm the cache via `OidcHandle` (the live `Option<OidcState>` shared as an Extension; `OidcState::is_ready()` is the cheap read-lock check). `static/index.html` disables the SSO button with a "temporarily unavailable" notice while `oidc_available` is false and polls `/api/auth/status` every 5s, re-enabling it on recovery — so the login page reflects provider state without a reload. Remember: `index.html` is a branded page served from memory, so this needs a rustguac restart to deploy (see in-memory page caching note).

### Roles

4-tier role hierarchy: `admin` (4) > `poweruser` (3) > `operator` (2) > `viewer` (1).
- **admin**: full access, connections folder/entry management
- **poweruser**: ad-hoc session creation + connections connect
- **operator**: connections connect only (no ad-hoc sessions)
- **viewer**: read-only

## Deployment

- **Bare metal**: `sudo ./install.sh` on Debian 13. Installs to `/opt/rustguac`, creates `rustguac` system user with home dir, sets up systemd services.
- **Docker**: `docker build -t rustguac .` — multi-stage, debian:trixie-slim runtime.
- **Remote test machine**: See project memory for connection details. Binary at `/opt/rustguac/bin/rustguac`, config at `/opt/rustguac/config.toml`.

## Build notes

- guacd is built from `../guacamole-server` (apache/guacamole-server)
- Debian 13 ships freerdp3-dev, not freerdp2-dev. guacamole-server 1.6.1+ has FreeRDP 3 auto-detection. Building with `--with-rdp`.
- **Patches required:** guacamole-server needs patches for FreeRDP 3.15+ (Debian 13). See `patches/README.md`. All build scripts apply these automatically.
- Chromium on headless VMs needs: `--in-process-gpu`, `--use-gl=angle`, `--use-angle=swiftshader`, `--disable-gpu-*`, `--disable-dev-shm-usage`
- The `rustguac` system user MUST have a real home directory (`/home/rustguac`) or Chromium's crashpad crashes with `trap int3`.
- Each Chromium session gets an isolated `--user-data-dir` to avoid profile lock conflicts.

### H.264 passthrough (RDP)

Per-connection **H.264** checkbox forwards the RDP server's H.264 stream to the
browser's WebCodecs decoder instead of decoding it in guacd and re-encoding as
JPEG/WebP. Takes guacd from ~100% of a core to ~2% with 1080p video, on both
xrdp and Windows. No environment variables — `enable-h264` is the only switch.

**Windows hosts need host-side settings, and one is non-obvious:** the Group
Policy *"Use WDDM graphics display driver for Remote Desktop Connections"* must
be **Disabled** or hardware H.264 encoding never engages (GPU 3D shows load
while Video Encode stays at 0%). `AVC444ModePreferred=1` is also required *for
hardware encoding*, and makes Windows send AVC444 — which is handled: both
views are forwarded and combined in the browser into full 4:4:4 chroma. Full
details, including verification commands, in `docs/rdp-h264.md`.

**AVC444 4:4:4 combining** (`static/guac/Yuv444.js`) — a WebGL2 shader unpacks
the auxiliary view's packed chroma (both MS-RDPEGFX layouts) and converts to
RGB in one pass, inverting the encoder's chroma filter to recover the one
sample per 2x2 block neither view carries. Frames are copied in the decoder's
own pixel format: `copyTo()` will not convert NV12 (what hardware decoders
give) to I420, so requesting a format throws before anything is copied. Two
runtime overrides, as window global / query param / localStorage:
`h264Chroma444` (off disables combining) and `h264ChromaFilter` (off, or a
0-255 threshold; default 30, from FreeRDP's `CONDITIONAL_CLIP`). Falls back to
4:2:0 on missing WebGL2, a lost context, or an unreadable pixel format.

### Native resolution (HiDPI)

Per-connection **Native Resolution** checkbox requests the framebuffer in the
browser's physical pixels rather than its CSS pixels, so text stays sharp on a
HiDPI display. The browser reports `device_pixel_ratio` on connect and the
server decides, since only the entry knows whether the target scales its own UI.

RDP is asked to scale via `desktopScaleFactor` (patch `011-rdp-dpi-scaling`).
**Only 100/140/180 work**, so the factor snaps to 1.4 or 1.8: MS-RDPBCGR
restricts `deviceScaleFactor` to those three, and FreeRDP transposes the pair
when synthesising a single-monitor definition, so only equal values survive.
The scale is re-sent on every display update — a `MONITOR_LAYOUT` carrying
zeroes resets the session to 100%, which used to undo it a second after connect.

X11 behind xrdp has no per-connection DPI negotiation; scale it inside the
session (`xfconf-query -c xsettings -p /Xft/DPI`). See `docs/xrdp-dpi-scaling.md`
for what an xrdp patch would involve.

## guacamole-server patches

The `patches/` directory contains patches applied to guacamole-server before building. These fix:

1. **Autoconf `-Werror` vs deprecated FreeRDP headers** — FreeRDP 3.15 deprecates `codecs_free()`, breaking `-Werror` compile tests and cascading into missing feature macros.
2. **Deprecated function pointer API** — Replaces `->input->KeyboardEvent()` etc. with `freerdp_input_send_keyboard_event()` safe API.
3. **NULL deref in display channel** — FreeRDP 3.x fires PubSub events before `guac_rdp_disp` is allocated.
4. **H.264 passthrough** (`004-h264-passthrough.patch`) — see `docs/rdp-h264.md`.

To add a new patch: edit `../guacamole-server`, export with `git diff > patches/NNN-description.patch`.

## Session types

- **SSH** — connects guacd directly to target SSH server
- **RDP** — connects guacd directly to target RDP server (same pattern as SSH, no browser spawning)
- **VNC** — connects guacd directly to target VNC server
- **Web** — spawns Xvnc + Chromium, guacd connects via VNC to local Xvnc display
- **VDI** — spawns Docker container with xrdp, guacd connects via RDP to container port 3389

### VDI (Docker containers)

Ephemeral per-user Docker desktop containers. `VdiDriver` trait in `src/vdi/mod.rs` enables downstream forks (JumpboxVDI) to add alternative backends (Nomad, Proxmox).

- Container naming: `rustguac-vdi-{username}` (deterministic, one per user)
- Lifecycle: created on first connect, persists after disconnect for `idle_timeout_mins`, reused on reconnect, destroyed on desktop logout or idle timeout
- Credentials: auto-generated per session (username from OIDC, random hex password), `chpasswd` updates on reuse
- BYO image: any Docker image with xrdp on port 3389 accepting `VDI_USERNAME`/`VDI_PASSWORD` env vars
- Test image: `contrib/vdi-test-image/` (Debian trixie + xrdp + xorgxrdp + xfce4)
- Thumbnails: client captures display screenshot every 10s, shown in connections "Active Sessions"
- Config: `[vdi]` section — `enabled`, `docker_socket`, `default_cpu_limit`, `default_memory_limit`, `ready_timeout_secs`, `idle_timeout_mins`, `allowed_images`, `home_base`
- Requires: `rustguac` user in `docker` group for socket access

## Ports

- 8089: rustguac HTTP/WebSocket
- 4822: guacd
- 6000-6099: Xvnc displays (:100-:199, internal)

## Testing

- `tests/test_browser_session.sh` — spawns Xvnc + Chromium, screenshots with xwd/ImageMagick, asserts non-black pixels
