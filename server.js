import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = __dirname;
const publicDir = path.join(rootDir, "web");
const noVncDir = path.join(rootDir, "vendor", "noVNC");
const sessionCookieName = "codex_session";
const defaultAppStartPath = path.join(
  rootDir,
  "vendor",
  "codex-desktop-linux",
  "codex-app",
  "start.sh",
);

const config = {
  appCommand:
    process.env.CODEX_APP_CMD ||
    process.env.APP_CMD ||
    (existsSync(defaultAppStartPath) ? defaultAppStartPath : ""),
  display: process.env.DISPLAY_ID || ":99",
  geometry: process.env.DISPLAY_GEOMETRY || process.env.XVNC_GEOMETRY || "1920x1080",
  depth: Number(process.env.DISPLAY_DEPTH || process.env.XVNC_DEPTH || 24),
  bindHost: process.env.BIND_HOST || "0.0.0.0",
  localHost: "127.0.0.1",
  httpPort: Number(process.env.PORT || 3000),
  vncPort: Number(process.env.VNC_PORT || 5901),
  autoStart: process.env.AUTO_START !== "false",
  windowManagerCommand: process.env.WINDOW_MANAGER_CMD || "",
  xvncCommand: process.env.XVNC_CMD || "",
  authUsername: process.env.AUTH_USERNAME || "admin",
  authPassword: process.env.AUTH_PASSWORD || "",
  sessionTtlMs: Number(process.env.SESSION_TTL_HOURS || 12) * 60 * 60 * 1000,
};

const generatedAuthPassword =
  config.authPassword || randomBytes(12).toString("base64url");

const state = {
  status: "idle",
  lastError: null,
  startedAt: null,
  processes: {
    app: null,
    wm: null,
    xserver: null,
  },
};

const sessions = new Map();

const server = http.createServer(handleRequest);
const wsServer = new WebSocketServer({ noServer: true });

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  await assertPaths();

  server.on("upgrade", (request, socket, head) => {
    if (!request.url?.startsWith("/websockify")) {
      socket.destroy();
      return;
    }

    const session = getSessionFromRequest(request);
    if (!session) {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\n" +
          "Connection: close\r\n" +
          "Content-Type: text/plain; charset=utf-8\r\n\r\n" +
          "Authentication required.",
      );
      socket.destroy();
      return;
    }

    wsServer.handleUpgrade(request, socket, head, (client) => {
      bridgeVnc(client);
    });
  });

  server.listen(config.httpPort, config.bindHost, () => {
    console.log(
      `Codex VNC web launcher listening on http://${config.bindHost}:${config.httpPort}`,
    );
    if (!config.authPassword) {
      console.log(
        `Authentication enabled with generated credentials: ${config.authUsername} / ${generatedAuthPassword}`,
      );
    }
  });

  if (config.autoStart) {
    launchStack().catch((error) => {
      state.status = "error";
      state.lastError = String(error);
      console.error(error);
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function handleRequest(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);
  pruneExpiredSessions();

  if (request.method === "GET" && url.pathname === "/login") {
    if (getSessionFromRequest(request)) {
      return redirect(response, "/");
    }
    return serveStatic(response, path.join(publicDir, "login.html"), publicDir);
  }

  if (request.method === "POST" && url.pathname === "/login") {
    return handleLogin(request, response);
  }

  if (request.method === "POST" && url.pathname === "/logout") {
    return handleLogout(request, response);
  }

  const session = getSessionFromRequest(request);
  if (!session) {
    return denyUnauthenticated(request, response);
  }

  if (url.pathname === "/api/status") {
    return json(response, 200, getStatusPayload());
  }

  if (url.pathname === "/api/start" && request.method === "POST") {
    try {
      await launchStack();
      return json(response, 200, getStatusPayload());
    } catch (error) {
      return json(response, 500, {
        ok: false,
        error: String(error),
        status: getStatusPayload(),
      });
    }
  }

  if (url.pathname === "/api/stop" && request.method === "POST") {
    await stopStack();
    return json(response, 200, getStatusPayload());
  }

  if (url.pathname === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (url.pathname.startsWith("/novnc/")) {
    return serveStatic(
      response,
      path.join(noVncDir, url.pathname.slice("/novnc/".length)),
      noVncDir,
    );
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    return serveStatic(response, path.join(publicDir, "index.html"), publicDir);
  }

  return serveStatic(response, path.join(publicDir, url.pathname), publicDir);
}

async function serveStatic(response, targetPath, root) {
  const normalized = path.normalize(targetPath);
  if (!normalized.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const body = await fs.readFile(normalized);
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": contentTypeFor(normalized),
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

async function handleLogin(request, response) {
  const contentType = request.headers["content-type"] || "";
  const body = await readRequestBody(request);

  let username = "";
  let password = "";

  if (contentType.includes("application/json")) {
    try {
      const payload = JSON.parse(body || "{}");
      username = String(payload.username || "");
      password = String(payload.password || "");
    } catch {
      return redirect(response, "/login?error=invalid");
    }
  } else {
    const params = new URLSearchParams(body);
    username = params.get("username") || "";
    password = params.get("password") || "";
  }

  if (!credentialsMatch(username, password)) {
    return redirect(response, "/login?error=invalid");
  }

  const sessionId = randomBytes(32).toString("base64url");
  sessions.set(sessionId, {
    username: config.authUsername,
    expiresAt: Date.now() + config.sessionTtlMs,
  });

  response.writeHead(303, {
    "location": "/",
    "set-cookie": buildSessionCookie(sessionId),
  });
  response.end();
}

async function handleLogout(request, response) {
  const cookies = parseCookies(request.headers.cookie || "");
  const sessionId = cookies[sessionCookieName];
  if (sessionId) {
    sessions.delete(sessionId);
  }

  response.writeHead(303, {
    "location": "/login",
    "set-cookie": clearSessionCookie(),
  });
  response.end();
}

function bridgeVnc(client) {
  const tcp = net.createConnection({
    host: config.localHost,
    port: config.vncPort,
  });

  client.on("message", (chunk, isBinary) => {
    tcp.write(isBinary ? chunk : Buffer.from(chunk));
  });

  client.on("close", () => {
    tcp.destroy();
  });

  client.on("error", () => {
    tcp.destroy();
  });

  tcp.on("data", (chunk) => {
    if (client.readyState === 1) {
      client.send(chunk, { binary: true });
    }
  });

  tcp.on("close", () => {
    client.close();
  });

  tcp.on("error", () => {
    client.close();
  });
}

function getSessionFromRequest(request) {
  const cookies = parseCookies(request.headers.cookie || "");
  const sessionId = cookies[sessionCookieName];
  if (!sessionId) {
    return null;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return null;
  }

  if (session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }

  session.expiresAt = Date.now() + config.sessionTtlMs;
  return session;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) {
      continue;
    }
    cookies[rawName] = decodeURIComponent(rawValue.join("="));
  }
  return cookies;
}

function buildSessionCookie(sessionId) {
  const parts = [
    `${sessionCookieName}=${encodeURIComponent(sessionId)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`,
  ];

  if (process.env.COOKIE_SECURE === "true") {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function clearSessionCookie() {
  return [
    `${sessionCookieName}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ].join("; ");
}

function credentialsMatch(username, password) {
  const expectedUsername = Buffer.from(config.authUsername);
  const providedUsername = Buffer.from(username);
  const expectedPassword = Buffer.from(generatedAuthPassword);
  const providedPassword = Buffer.from(password);

  return (
    expectedUsername.length === providedUsername.length &&
    expectedPassword.length === providedPassword.length &&
    timingSafeEqual(expectedUsername, providedUsername) &&
    timingSafeEqual(expectedPassword, providedPassword)
  );
}

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(sessionId);
    }
  }
}

function denyUnauthenticated(request, response) {
  if (request.url?.startsWith("/api/")) {
    return json(response, 401, {
      ok: false,
      error: "Authentication required.",
    });
  }

  return redirect(response, "/login");
}

function redirect(response, location) {
  response.writeHead(303, {
    "location": location,
    "cache-control": "no-store",
  });
  response.end();
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function launchStack() {
  if (state.status === "starting" || state.status === "running") {
    return;
  }

  await stopStack();
  state.status = "starting";
  state.lastError = null;

  const xvncCommand = await resolveXvncCommand();
  if (!xvncCommand) {
    state.status = "error";
    state.lastError = "Missing required command: Xvnc";
    throw new Error(state.lastError);
  }

  if (!(await commandExists("bash"))) {
    state.status = "error";
    state.lastError = "Missing required command: bash";
    throw new Error(state.lastError);
  }

  if (!config.appCommand.trim()) {
    state.status = "error";
    state.lastError =
      "Set CODEX_APP_CMD to the Linux Codex app launcher command.";
    throw new Error(state.lastError);
  }

  await cleanupDisplayArtifacts();

  state.processes.xserver = spawnManagedProcess(
    "xserver",
    [
      xvncCommand,
      config.display,
      "-geometry",
      config.geometry,
      "-depth",
      String(config.depth),
      "-rfbport",
      String(config.vncPort),
      "-localhost",
      "-AlwaysShared",
      "-SecurityTypes",
      "None",
      "-AcceptCutText=0",
      "-SendCutText=0",
      "-AcceptSetDesktopSize=0",
    ],
    { env: process.env },
  );

  await waitForDisplay();
  await waitForTcpPort(config.vncPort);

  const baseEnv = {
    ...process.env,
    DISPLAY: config.display,
  };

  if (config.windowManagerCommand.trim()) {
    state.processes.wm = spawnManagedShell(
      "wm",
      config.windowManagerCommand,
      { env: baseEnv },
    );
  }

  state.processes.app = spawnManagedShell("app", config.appCommand, {
    env: baseEnv,
  });

  state.status = "running";
  state.startedAt = new Date().toISOString();
}

async function stopStack() {
  const names = ["app", "wm", "xserver"];
  for (const name of names) {
    const proc = state.processes[name];
    if (!proc) {
      continue;
    }
    proc.removeAllListeners("exit");
    proc.kill("SIGTERM");
    state.processes[name] = null;
  }

  await sleep(250);
  await cleanupDisplayArtifacts();

  state.status = "idle";
  state.startedAt = null;
}

function spawnManagedShell(name, command, options) {
  return spawnManagedProcess(name, ["bash", "-lc", command], options);
}

function spawnManagedProcess(name, argv, options) {
  const [command, ...args] = argv;
  const proc = spawn(command, args, {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

  proc.stdout.on("data", (chunk) => {
    process.stdout.write(`[${name}] ${chunk}`);
  });
  proc.stderr.on("data", (chunk) => {
    process.stderr.write(`[${name}] ${chunk}`);
  });
  proc.on("exit", (code, signal) => {
    const expectedIdle = state.status === "idle";
    state.processes[name] = null;
    if (!expectedIdle && state.status !== "error") {
      state.status = "error";
      state.lastError = `${name} exited (${signal || code})`;
    }
  });

  return proc;
}

async function resolveXvncCommand() {
  const candidates = [
    config.xvncCommand,
    "Xvnc",
    "Xtigervnc",
  ].filter(Boolean);

  for (const command of candidates) {
    if (await commandExists(command)) {
      return command;
    }
  }

  return "";
}

function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", `command -v ${command}`], {
      stdio: "ignore",
    });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

function waitForDisplay(timeoutMs = 10000) {
  const displayNumber = config.display.replace(/^:/, "");
  const socketPath = `/tmp/.X11-unix/X${displayNumber}`;
  return waitForCondition(
    async () => {
      try {
        await fs.access(socketPath);
        return true;
      } catch {
        return false;
      }
    },
    timeoutMs,
  );
}

function waitForTcpPort(port, timeoutMs = 10000) {
  return waitForCondition(
    () =>
      new Promise((resolve) => {
        const socket = net.createConnection({ host: config.localHost, port });
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
      }),
    timeoutMs,
  );
}

async function waitForCondition(check, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) {
      return;
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for the display stack to become ready.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupDisplayArtifacts() {
  const displayNumber = config.display.replace(/^:/, "");
  const lockPath = `/tmp/.X${displayNumber}-lock`;
  const socketPath = `/tmp/.X11-unix/X${displayNumber}`;

  await fs.rm(lockPath, { force: true }).catch(() => {});
  await fs.rm(socketPath, { force: true }).catch(() => {});
}

function getStatusPayload() {
  return {
    status: state.status,
    lastError: state.lastError,
    startedAt: state.startedAt,
    config: {
      appCommand: config.appCommand,
      bindHost: config.bindHost,
      display: config.display,
      geometry: config.geometry,
      depth: config.depth,
      httpPort: config.httpPort,
      vncPort: config.vncPort,
      windowManagerCommand: config.windowManagerCommand,
    },
    processes: Object.fromEntries(
      Object.entries(state.processes).map(([name, proc]) => [
        name,
        proc
          ? {
              pid: proc.pid,
              running: !proc.killed,
            }
          : null,
      ]),
    ),
  };
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload, null, 2));
}

async function assertPaths() {
  await fs.access(path.join(publicDir, "index.html"));
  await fs.access(path.join(noVncDir, "core", "rfb.js"));
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath);
  switch (ext) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".ico":
      return "image/x-icon";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function shutdown() {
  stopStack().finally(() => {
    server.close(() => process.exit(0));
  });
}
