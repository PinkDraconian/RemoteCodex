# Codex Web Console

This project exposes a Linux Codex desktop app in the browser using the stack you described:

```text
Linux app -> Xvnc -> WebSocket proxy -> browser
```

## What it does

- starts `Xvnc` as both the X server and VNC server
- launches your Linux Codex app command on that display
- serves a browser page backed by upstream `noVNC`
- proxies `/websockify` WebSocket traffic to the local VNC TCP socket

## Requirements

- `Xvnc` from TigerVNC
- a Linux Codex app launcher command

The app command is provided through `CODEX_APP_CMD`.

Authentication is enforced by the Node server before the viewer, API, and
WebSocket VNC bridge are accessible.

Example:

```bash
export CODEX_APP_CMD="$HOME/codex-desktop-linux/codex-app/start.sh"
```

## Build the Linux app

If you do not already have a Linux Codex app bundle, build it from the cached official DMG with Docker:

```bash
npm run build:linux-app
```

That produces:

```text
vendor/codex-desktop-linux/codex-app/start.sh
```

## Setup

```bash
npm install
npm run build:linux-app
npm run doctor
npm start
```

Then open:

```text
http://127.0.0.1:3000
```

## Optional environment

- `PORT`: HTTP port, default `3000`
- `DISPLAY_ID`: X11 display, default `:99`
- `VNC_PORT`: local VNC port, default `5901`
- `DISPLAY_GEOMETRY`: virtual screen size, default `1920x1080`
- `DISPLAY_DEPTH`: Xvnc color depth, default `24`
- `XVNC_CMD`: override Xvnc binary path/name
- `WINDOW_MANAGER_CMD`: optional window manager command, for example `openbox`
- `AUTO_START=false`: start the web server without launching the stack immediately
- `AUTH_USERNAME`: login username, default `admin`
- `AUTH_PASSWORD`: login password. If unset, the server generates one at startup and prints it to stdout
- `SESSION_TTL_HOURS`: session lifetime, default `12`
- `COOKIE_SECURE=true`: mark the session cookie as `Secure` when serving behind HTTPS

## Current boundary

This project launches and proxies the display stack. It does not install TigerVNC or build the Linux Codex app for you. If the machine is missing `Xvnc` or the Linux Codex app itself, `npm run doctor` and the web status page will show that directly.
