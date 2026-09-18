import { fileURLToPath } from "node:url";
import { sites } from "@openai/sites-vite-plugin";
import vinext from "vinext";
import { defineConfig } from "vite";
// `npx @vinext/cloudflare deploy`'s pre-flight check
// (viteConfigHasCloudflarePlugin in @vinext/cloudflare/dist/deploy-config.js)
// is a plain regex over this file's own source text: it requires a static
// `import { cloudflare } from "@cloudflare/vite-plugin"` AND a later call
// that literally reads `cloudflare(` — matched against *this import's own
// binding name specifically*, not just any `cloudflare(` in the file. So
// the binding here must be named exactly `cloudflare`, unaliased, even
// though it's never called: the real call (line ~79) is on the *locally
// shadowed* `cloudflare` from the dynamic `await import(...)` inside
// defineConfig's callback (deliberately dynamic so the env vars set right
// before it run first — see the comment there) — a different binding in a
// nested scope, invisible to this top-level one. Referencing this outer
// import only via `typeof` below (never as a value) means standard
// TS/esbuild import elision (the same mechanism that makes `import type`
// usually unnecessary) should drop it from the actual build — reasoned
// through, not directly inspected in the compiled output, so treat
// `npm run dev`/`build`/`start` continuing to work as the real
// confirmation, not this comment.
import { cloudflare } from "@cloudflare/vite-plugin";
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- type-only usage of the import above; see the comment on it.
type _CloudflarePluginTypeOnly = typeof cloudflare;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  triggers: { crons: ["* * * * *"] },
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    resolve: {
      alias: {
        // Replicates what next-intl's Next.js config plugin does for real
        // Next.js/webpack: point the internal `next-intl/config` module at the
        // user's i18n/request.ts. There's no next.config.js here for the
        // plugin to patch, so it's done directly at the Vite level instead.
        "next-intl/config": fileURLToPath(new URL("./i18n/request.ts", import.meta.url)),
      },
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
