// Local preview of the public portfolio demo, the same way Vercel serves it:
// static files from showcase/ and the /api/analyze function.
//
//   npm run showcase          (from the project root; reads GROQ_* from .env)
//   open http://localhost:4321
//
// Without GROQ_API_KEY / GROQ_MODEL the page runs in its labeled simulation mode.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import handler from "../api/analyze.js";

const ROOT = fileURLToPath(new URL("../showcase/", import.meta.url));
const PORT = Number(process.env.SHOWCASE_PORT) || 4321;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
const HEADERS = vercel.headers[0].headers;

createServer(async (req, res) => {
  for (const h of HEADERS) res.setHeader(h.key, h.value);
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/api/analyze") return handler(req, res);
  const file = normalize(join(ROOT, path.endsWith("/") ? `${path}index.html` : path));
  if (!file.startsWith(ROOT)) { res.statusCode = 404; return res.end("Not found"); }
  try {
    const body = await readFile(file);
    res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Portfolio demo: http://localhost:${PORT}`);
  console.log(process.env.GROQ_API_KEY ? "Live AI: on (Groq)" : "Live AI: off (no GROQ_API_KEY) - the page uses its labeled simulation");
});
