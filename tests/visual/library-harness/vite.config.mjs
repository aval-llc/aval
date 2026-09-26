/**
 * A browser harness for the agent library, for visual checks where a signed-in
 * local session is impossible (local sign-in needs Supabase Auth, which needs a
 * container runtime). It renders the real components with the app's real CSS
 * and messages; only the network is replaced, by fixtures shaped exactly like
 * the routes' responses (fixtures.ts). Never built into the app.
 *
 *   npx vite --config tests/visual/library-harness/vite.config.mjs
 */
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));

export default defineConfig({
  root,
  // The app serves avatars and fonts from public/.
  publicDir: `${repo}public`,
  plugins: [react()],
  css: { postcss: repo },
  resolve: { alias: [{ find: /^@\//, replacement: repo }] },
  server: { port: 5199, strictPort: true, fs: { allow: [repo] } },
});
