// Demo mode: runs the backend on this laptop AND gives it a free public HTTPS
// address through a Cloudflare "quick tunnel" (no account, no card).
//
//   npm run demo        (instead of npm run dev; Ctrl+C stops both)
//
// The address changes every time you start it, and it works only while this
// runs. Needs cloudflared:  brew install cloudflared
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT) || 3000;
const BACKEND_DIR = fileURLToPath(new URL("..", import.meta.url));
const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

const portInUse = () =>
  new Promise((resolve) => {
    const socket = connect(PORT, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });

if (await portInUse()) {
  console.error(`Port ${PORT} is busy: stop "npm run dev" (Ctrl+C in its terminal) first, then run "npm run demo" again.`);
  process.exit(1);
}

let backend = null;
let stopping = false;

const tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://localhost:${PORT}`], {
  stdio: ["ignore", "pipe", "pipe"],
});
tunnel.on("error", (err) => {
  console.error(err.code === "ENOENT" ? "cloudflared is not installed. Run: brew install cloudflared" : err.message);
  process.exit(1);
});

console.log("Opening a public tunnel (takes a few seconds)...");
const giveUp = setTimeout(() => {
  console.error("The tunnel did not connect within 45 seconds. Check your internet connection and try again.");
  shutdown(1);
}, 45_000);

// The address appears before the tunnel is connected; links shared before
// "Registered tunnel connection" show Cloudflare error 1033. Wait for both.
let tunnelLog = "";
let ready = false;
function onTunnelOutput(chunk) {
  if (ready) return;
  tunnelLog += chunk.toString();
  const match = TUNNEL_URL.exec(tunnelLog);
  if (!match || !/Registered tunnel connection/.test(tunnelLog)) return;
  ready = true;
  clearTimeout(giveUp);
  // A few more seconds for Cloudflare to route the new address everywhere.
  setTimeout(() => { if (!stopping) startBackend(match[0]); }, 4000);
}
tunnel.stdout.on("data", onTunnelOutput);
tunnel.stderr.on("data", onTunnelOutput);
tunnel.on("exit", (code) => {
  if (!stopping) {
    console.error(`The tunnel stopped (code ${code}). Stopping the backend too.`);
    shutdown(1);
  }
});

function startBackend(publicUrl) {
  console.log(`\nPublic address: ${publicUrl}`);
  console.log("Share the form link printed below. It works from any phone while this runs.\n");
  backend = spawn(process.execPath, ["--env-file=../.env", "src/index.js"], {
    cwd: BACKEND_DIR,
    stdio: "inherit",
    env: {
      ...process.env,
      PUBLIC_BASE_URL: publicUrl,
      // Visitors arrive through the tunnel; their real address is in X-Forwarded-For.
      TRUST_PROXY: "true",
      // Customers see the real page (no "Development server" note).
      NODE_ENV: "production",
      PORT: String(PORT),
    },
  });
  backend.on("exit", (code) => {
    if (!stopping) {
      console.error(`The backend stopped (code ${code}). Closing the tunnel.`);
      shutdown(code ?? 1);
    }
  });
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(giveUp);
  // The backend finishes the job in progress on SIGTERM.
  backend?.kill("SIGTERM");
  tunnel.kill("SIGTERM");
  const done = () => process.exit(code);
  if (backend && backend.exitCode === null) backend.once("exit", done);
  else done();
  setTimeout(done, 15_000).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
