# Deployment — Direct Beam Tracker Viewer

Goal: kotekan is already running on the processing node. You deploy the
viewer next to it, SSH in with a port forward, and open the viewer in a
browser — from your laptop and any number of other PCs.

## 1. One-time setup on the processing node

Prereqs: [uv](https://docs.astral.sh/uv/) installed
(`curl -LsSf https://astral.sh/uv/install.sh | sh`), and the repo checked out.

```bash
cd direct-beam-tracker-viewer
uv sync                 # creates .venv, installs deps from pyproject.toml
```

That's it. No system Python, no pip, no build tools.

## 2. Run

```bash
# kotekan REST server defaults to :12048 on the same node
uv run viewer --kotekan http://localhost:12048 --port 8088
```

Defaults: binds `127.0.0.1:8088`, polls kotekan at 2 Hz. Override with
`--host/--port/--poll-interval` or env vars `KOTEKAN_URL`, `VIEWER_HOST`,
`VIEWER_PORT`.

To keep it running after logout:

```bash
nohup uv run viewer --port 8088 > viewer.log 2>&1 &
# or a systemd user unit / tmux session — operator's choice
```

## 3. Access from your PC(s) — SSH tunnel

On **each** operator PC:

```bash
ssh -L 8088:localhost:8088 user@processing-node
```

then open <http://localhost:8088> in the browser. Every PC makes its own
tunnel; all of them share the same viewer instance, and the viewer still
polls kotekan **once** at 2 Hz regardless of how many browsers are open.

Optional: add to `~/.ssh/config` on each PC:

```
Host charts-viewer
    HostName processing-node
    User user
    LocalForward 8088 localhost:8088
```

then `ssh charts-viewer` and browse.

### Direct LAN access (optional, trusted subnet only)

```bash
uv run viewer --host 0.0.0.0 --port 8088
```

and browse to `http://<node-ip>:8088` — no tunnel. There is **no
authentication**; only do this on a subnet you trust, same as the kotekan
REST server itself.

## 4. Load on the processing node

- One `GET /direct_tracker/status` (a few KB of JSON) every 500 ms — negligible.
- Browser fan-out happens inside the viewer process over WebSocket; kotekan
  never sees viewer clients.
- Control actions (steer/mask/enable) are human clicks, proxied 1:1.

## 5. Health check

```bash
curl http://localhost:8088/api/health
# {"kotekan_reachable": true, "poll_interval_s": 0.5, "uptime_s": 123.4}
```
