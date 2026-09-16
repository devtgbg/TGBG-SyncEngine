import path from "node:path";
import type { NextConfig } from "next";

/**
 * The dashboard is its own package inside the Zupersync repo, so there are two
 * lockfiles: the service's package-lock.json at the repo root and this app's
 * pnpm-lock.yaml. Next walks upward looking for a workspace root, finds the
 * root lockfile first and traces files from there — which pulls the service's
 * dependency tree into this app's build output.
 *
 * Pin the root to this directory so tracing stays inside the app.
 */
const nextConfig: NextConfig = {
  outputFileTracingRoot: path.resolve(__dirname),
  // Emit a self-contained server for the Docker image: only the modules actually
  // imported, so the runtime stage needs no node_modules copy at all.
  output: "standalone",
};

export default nextConfig;
