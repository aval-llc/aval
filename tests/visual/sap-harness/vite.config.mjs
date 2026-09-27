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
  server: { port: 5200, strictPort: true, fs: { allow: [repo] } },
});
