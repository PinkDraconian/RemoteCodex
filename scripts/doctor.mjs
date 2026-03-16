import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const defaultAppPath = path.join(
  rootDir,
  "vendor",
  "codex-desktop-linux",
  "codex-app",
  "start.sh",
);

const commands = ["bash"];

const xvncCommand = await resolveXvncCommand();

const appCommand =
  process.env.CODEX_APP_CMD ||
  process.env.APP_CMD ||
  (existsSync(defaultAppPath) ? defaultAppPath : "");

for (const command of commands) {
  const ok = await commandExists(command);
  console.log(`${ok ? "OK " : "MISS"} ${command}`);
}

if (xvncCommand) {
  console.log(`OK  Xvnc=${xvncCommand}`);
} else {
  console.log("MISS Xvnc");
}

if (appCommand.trim()) {
  console.log(`OK  CODEX_APP_CMD=${appCommand}`);
} else {
  console.log("MISS CODEX_APP_CMD");
}

async function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", `command -v ${command}`], {
      stdio: "ignore",
    });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

async function resolveXvncCommand() {
  const candidates = [
    process.env.XVNC_CMD || "",
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
