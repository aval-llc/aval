/** Node transpilation and Worker/model seams. Database access uses real DbSession. */

import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const VIRTUAL = {
  "cloudflare:workers": "export const env = globalThis.__CF_ENV__ ?? {};",
  "@/lib/ask-aval/model-router": "export async function callModel(session, env, orgId, params) { return session.outsideTransaction(() => (params.tool_choice?.name === 'semantic_verdict' ? globalThis.__SEMANTIC_MODEL__ : globalThis.__MODEL__)(env, orgId, params)); }",
};
const virtualUrl = (s) => `debugstub:${encodeURIComponent(s)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in VIRTUAL) return { url: virtualUrl(specifier), shortCircuit: true };
    if (specifier.startsWith("@/")) {
      const base = `${ROOT}/${specifier.slice(2)}`;
      for (const candidate of [base, `${base}.ts`, `${base}/index.ts`, `${base}.tsx`]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
      throw new Error(`debug harness could not resolve ${specifier}`);
    }
    // vite resolves extensionless relative imports; node does not.
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const baseUrl = new URL(specifier, context.parentURL);
      // URL.pathname is not a native Windows path and may still contain URL
      // escapes (for example `%20`). Convert it before consulting the file
      // system so the harness works from checkouts whose path contains spaces.
      const basePath = fileURLToPath(baseUrl);
      if (!existsSync(basePath) || statSync(basePath).isDirectory()) {
        for (const ext of [".ts", ".tsx", "/index.ts", ".js"]) {
          const candidate = basePath + ext;
          if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("debugstub:")) {
      return { format: "module", source: VIRTUAL[decodeURIComponent(url.slice("debugstub:".length))], shortCircuit: true };
    }
    // node's strip-only TS mode chokes on parameter properties and enums that
    // exist in this repo; esbuild is already a dependency and handles them.
    if (url.startsWith("file:") && (url.endsWith(".ts") || url.endsWith(".tsx"))) {
      const path = fileURLToPath(url);
      const { code } = transformSync(readFileSync(path, "utf8"), {
        loader: url.endsWith(".tsx") ? "tsx" : "ts",
        jsx: "automatic",
        format: "esm",
        target: "es2022",
        sourcefile: path,
      });
      return { format: "module", source: code, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
