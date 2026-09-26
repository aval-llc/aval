/** Read-only ByDesign OData v2 transport. No database session or global credentials. */
export class ByDesignError extends Error {
  code: string;
  retryable: boolean;
  retryAfterSeconds: number;
  constructor(code: string, retryable = false, retryAfterSeconds = 0) {
    super(`ByDesign read failed: ${code}`);
    this.name = "ByDesignError";
    this.code = code;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface ByDesignReadConfig {
  tenantUrl: string;
  collectionPath: string;
  select: string[];
  /** A unique, stable ordering is required for offset pagination. */
  orderBy: string[];
  companyFilter: { field: string; value: string };
  pageSize?: number;
  maxRows?: number;
  maxPages?: number;
}
export type ByDesignCredentials = { username: string; password: string };
export type ByDesignFetch = (url: string, init: RequestInit) => Promise<Response>;
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
function fail(code: string): never { throw new ByDesignError(code); }

function boundedInteger(value: number, max: number) {
  if (!Number.isInteger(value) || value < 1 || value > max) fail("INVALID_LIMIT");
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_ODATA_RESPONSE");
  return value as Record<string, unknown>;
}

function collectionUrl(config: ByDesignReadConfig) {
  let tenant: URL;
  try { tenant = new URL(config.tenantUrl); } catch { return fail("INVALID_TENANT"); }
  if (tenant.protocol !== "https:" || !/^[a-z0-9-]+\.sapbydesign\.com$/.test(tenant.hostname) ||
    tenant.username || tenant.password || tenant.port || tenant.search || tenant.hash || tenant.pathname !== "/") fail("INVALID_TENANT");
  // Only explicit collection paths, not arbitrary URLs, function imports or $batch.
  if (!/^\/sap\/byd\/odata\/(?:analytics\/ds\/[A-Za-z0-9_]+\.svc|cust\/v1\/[A-Za-z0-9_]+)\/[A-Za-z0-9_]+$/.test(config.collectionPath)) fail("INVALID_COLLECTION");
  if (!config.select.length || config.select.length > 50 || !config.orderBy.length ||
    [...config.select, ...config.orderBy, config.companyFilter.field].some(f => !identifier.test(f)) ||
    config.orderBy.some(f => !config.select.includes(f)) || !config.select.includes(config.companyFilter.field)) fail("INVALID_FIELDS");
  if (!config.companyFilter.value || config.companyFilter.value.length > 100 || Array.from(config.companyFilter.value).some(c => c.charCodeAt(0) < 32)) fail("INVALID_COMPANY_FILTER");
  const url = new URL(config.collectionPath, tenant);
  url.searchParams.set("$format", "json");
  url.searchParams.set("$select", [...new Set(config.select)].join(","));
  url.searchParams.set("$orderby", config.orderBy.join(","));
  url.searchParams.set("$filter", `${config.companyFilter.field} eq '${config.companyFilter.value.replaceAll("'", "''")}'`);
  return url;
}

async function jsonPage(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return fail("EMPTY_RESPONSE");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 500_000) { await reader.cancel(); fail("PAGE_TOO_LARGE"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return object(JSON.parse(new TextDecoder().decode(bytes))); }
  catch { return fail("INVALID_JSON_RESPONSE"); }
}

/** Fetch all bounded pages before returning any data. Call before opening a DB transaction.
 * A failed/partial read never returns a success-shaped partial dataset. */
export async function readByDesignCollection(config: ByDesignReadConfig, credentials: ByDesignCredentials, fetcher: ByDesignFetch = fetch) {
  return readCollection(config, credentials, fetcher, false);
}

/** A single scoped row proves read access only, never import completeness. */
export async function probeByDesignCollection(config: ByDesignReadConfig, credentials: ByDesignCredentials, fetcher: ByDesignFetch = fetch) {
  const result = await readCollection({ ...config, pageSize: 1 }, credentials, fetcher, true);
  return { sampleCount: result.rows.length, checkedAt: result.fetchedAt };
}

/** Validate administrator-supplied field names before saving any credentials. */
export function byDesignConnectionConfig(credentials: Record<string, string>): ByDesignReadConfig {
  const config: ByDesignReadConfig = {
    tenantUrl: credentials.tenantUrl?.trim() ?? "",
    collectionPath: credentials.collectionPath?.trim() ?? "",
    select: [credentials.companyField?.trim() ?? "", ...(credentials.recordKeyFields ?? "").split(",").map(f => f.trim())],
    orderBy: (credentials.recordKeyFields ?? "").split(",").map(f => f.trim()),
    companyFilter: { field: credentials.companyField?.trim() ?? "", value: credentials.companyId?.trim() ?? "" },
  };
  collectionUrl(config);
  return config;
}

async function readCollection(config: ByDesignReadConfig, credentials: ByDesignCredentials, fetcher: ByDesignFetch, probe: boolean) {
  const base = collectionUrl(config);
  const pageSize = boundedInteger(config.pageSize ?? 100, 100);
  const maxRows = boundedInteger(config.maxRows ?? 500, 500);
  const maxPages = boundedInteger(config.maxPages ?? 20, 50);
  if (!credentials.username || credentials.username.includes(":") || !credentials.password ||
    credentials.username.length > 200 || credentials.password.length > 2000) fail("INVALID_CREDENTIALS");
  const authBytes = new TextEncoder().encode(`${credentials.username}:${credentials.password}`);
  const authorization = `Basic ${btoa(Array.from(authBytes, b => String.fromCharCode(b)).join(""))}`;
  let next: URL | null = new URL(base);
  next.searchParams.set("$top", String(pageSize));
  next.searchParams.set("$skip", "0");
  const rows: Record<string, unknown>[] = [];
  const seenPages = new Set<string>(), seenKeys = new Set<string>();
  let pages = 0;
  while (next) {
    if (pages >= maxPages) fail("PAGE_LIMIT_EXCEEDED");
    // Never forward credentials to another host, collection, or a modified scope.
    if (next.origin !== base.origin || next.pathname !== base.pathname || next.username || next.password || next.hash ||
      [...next.searchParams.keys()].some(k => !["$format", "$select", "$orderby", "$filter", "$top", "$skip", "$skiptoken"].includes(k)) ||
      ["$format", "$select", "$orderby", "$filter"].some(k => next!.searchParams.getAll(k).length !== 1 || next!.searchParams.get(k) !== base.searchParams.get(k))) fail("UNSAFE_CONTINUATION");
    next.searchParams.sort();
    if (seenPages.has(next.href)) fail("PAGINATION_LOOP");
    seenPages.add(next.href);
    pages++;
    let response: Response;
    try {
      response = await fetcher(next.href, { method: "GET", headers: { authorization, accept: "application/json", DataServiceVersion: "2.0" }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    } catch { throw new ByDesignError("NETWORK_OR_TIMEOUT", true); }
    if (response.status !== 200 || response.redirected) {
      const retry = response.headers.get("retry-after");
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? Math.ceil((Date.parse(retry) - Date.now()) / 1000) : 0;
      await response.body?.cancel();
      throw new ByDesignError(response.status === 401 ? "UNAUTHORIZED" : response.status === 403 ? "FORBIDDEN" : response.status === 429 ? "RATE_LIMITED" : response.status >= 300 && response.status < 400 || response.redirected ? "REDIRECT_REJECTED" : "HTTP_FAILURE",
        response.status === 429 || response.status >= 500, Math.min(3600, Math.max(0, Number.isFinite(seconds) ? seconds : 0)));
    }
    let payload: Record<string, unknown>;
    try { payload = await jsonPage(response); }
    catch (error) { if (error instanceof ByDesignError) throw error; throw new ByDesignError("NETWORK_OR_TIMEOUT", true); }
    if (payload.error) fail("ODATA_ERROR");
    const data = object(payload.d);
    if (!Array.isArray(data.results)) fail("INVALID_ODATA_RESPONSE");
    const page = data.results.map(object);
    if (page.length > pageSize) fail("UNEXPECTED_PAGE_SIZE");
    for (const row of page) {
      if (row[config.companyFilter.field] !== config.companyFilter.value) fail("COMPANY_SCOPE_MISMATCH");
      const values = config.orderBy.map(field => row[field]);
      if (values.some(v => typeof v !== "string" || !v || v.length > 200)) fail("INVALID_RECORD_KEY");
      const key = JSON.stringify(values);
      if (seenKeys.has(key)) fail("DUPLICATE_RECORD_KEY");
      seenKeys.add(key);
      rows.push(row);
      if (rows.length > maxRows) fail("ROW_LIMIT_EXCEEDED");
    }
    if (probe) break; // Verification deliberately does not follow pagination or return records.
    if (data.__next !== undefined) {
      if (typeof data.__next !== "string" || !data.__next || !page.length) fail("INVALID_CONTINUATION");
      try { next = new URL(data.__next, next); } catch { fail("UNSAFE_CONTINUATION"); }
    } else if (page.length === pageSize) {
      // Some ByD services use client paging. A final empty page proves completion.
      next = new URL(base);
      next.searchParams.set("$top", String(pageSize));
      next.searchParams.set("$skip", String(rows.length));
    } else next = null;
  }
  return { rows, pages, fetchedAt: new Date().toISOString(), product: "sap_business_bydesign" as const };
}
