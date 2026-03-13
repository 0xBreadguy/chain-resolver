#!/usr/bin/env bun
/**
 * Simple preview server for chain data
 * Serves the web/preview.html and aggregates chain data from data/chains/*.json
 *
 * Usage: bun run scripts/preview-server.ts
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const PORT = process.env.PORT || 3000;
const CHAINS_DIR = "data/chains";
const WEB_DIR = "web";

// Load all chain data
function loadChains() {
  const files = readdirSync(CHAINS_DIR).filter(
    (f) => f.endsWith(".json") && !f.startsWith("_")
  );

  const chains = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(CHAINS_DIR, file), "utf8");
      const chain = JSON.parse(content);
      if (chain.label) {
        chains.push(chain);
      }
    } catch (e) {
      console.warn(`Failed to load ${file}:`, e);
    }
  }

  return chains;
}

// MIME types
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    let pathname = url.pathname;

    // API endpoint for chain data
    if (pathname === "/api/chains") {
      const chains = loadChains();
      return new Response(JSON.stringify(chains, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Serve static files
    if (pathname === "/" || pathname === "/preview") {
      pathname = "/preview.html";
    }

    // Try web directory first
    let filePath = join(WEB_DIR, pathname);
    if (!existsSync(filePath)) {
      // Try root directory
      filePath = pathname.slice(1);
    }

    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath);
        const ext = pathname.substring(pathname.lastIndexOf("."));
        const contentType = MIME_TYPES[ext] || "application/octet-stream";

        return new Response(content, {
          headers: { "Content-Type": contentType },
        });
      } catch {
        return new Response("Error reading file", { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`
╔════════════════════════════════════════════════════╗
║          Chain Preview Server                      ║
╠════════════════════════════════════════════════════╣
║  Preview:  http://localhost:${PORT}/                   ║
║  API:      http://localhost:${PORT}/api/chains         ║
╚════════════════════════════════════════════════════╝
`);
