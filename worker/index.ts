/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { authenticateSupabaseRequest, appendResponseCookies } from "@/lib/auth/supabase";
import { withVerifiedIdentityHeaders, withoutUntrustedIdentityHeaders } from "@/lib/auth/request-identity";
import type { AvalRuntimeBindings } from "@/lib/runtime/bindings";

interface Env extends AvalRuntimeBindings {
  ASSETS: Fetcher;
  HYPERDRIVE: { connectionString: string };
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    // Public callers can supply arbitrary headers. Strip all identity-shaped
    // headers, validate the HttpOnly Supabase session, then add a private
    // identity envelope for the Vinext route and Server Component layers.
    let requestHeaders = withoutUntrustedIdentityHeaders(request.headers);
    let responseCookies: string[] = [];
    const staticAsset = url.pathname.startsWith("/_next/") || url.pathname.startsWith("/assets/") || url.pathname === "/favicon.ico";
    const authMutation = ["/api/auth/login", "/api/auth/signup", "/api/auth/logout", "/api/auth/forgot-password", "/api/auth/resend-verification", "/api/auth/confirm"].includes(url.pathname);
    if (!staticAsset && !authMutation) {
      const authentication = await authenticateSupabaseRequest(request, env);
      if (authentication) {
        requestHeaders = withVerifiedIdentityHeaders(requestHeaders, authentication.identity);
        responseCookies = authentication.responseCookies;
      }
    }
    const appRequest = new Request(request, { headers: requestHeaders });
    const response = await handler.fetch(appRequest, env, ctx);
    return appendResponseCookies(response, responseCookies);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Request waitUntil gives new tasks a fast start; this minute sweep is the
    // durable continuation and crash-recovery path. The sweep resolves tenant
    // work with the system role and opens one RLS-scoped session per tenant.
    ctx.waitUntil(import("@/lib/workers/scheduled-sweep").then(({ runScheduledSweep }) =>
      runScheduledSweep(env),
    ));
  },
};

export default worker;
