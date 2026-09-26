import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "@/messages/en.json";
import "@/app/globals.css";
import "@/app/enterprise.css";
import "@/app/agent-library.css";
import { EmployeeDirectory } from "@/app/components/employee-directory";
import { EMPLOYEES, TASKS, TEMPLATES, organization } from "./fixtures";

/**
 * The network, replaced. `?role=member` makes every write answer as the real
 * route does for a non-owner (403), so permission handling can be seen.
 */
const params = new URLSearchParams(location.search);
const role = params.get("role") ?? "owner";
const employees = [...EMPLOYEES];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  const method = (init?.method ?? "GET").toUpperCase();
  await new Promise((resolve) => setTimeout(resolve, 40));
  if (url.pathname === "/api/agents/organization") return json(organization(url.searchParams.get("include") === "specialists"));
  if (url.pathname === "/api/agents/employees" && method === "GET") {
    const search = (url.searchParams.get("search") ?? "").toLowerCase();
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 24);
    const rows = employees.filter((row) => `${row.name} ${row.role}`.toLowerCase().includes(search));
    return json({ employees: rows.slice(offset, offset + limit), total: rows.length, limit: null, templates: TEMPLATES });
  }
  if (url.pathname === "/api/agents/employees" && method === "POST") {
    if (role !== "owner") return json({ error: "Only workspace owners can create and configure employees." }, 403);
    const body = JSON.parse(String(init?.body ?? "{}"));
    const template = TEMPLATES.find((row) => row.slug === body.templateSlug);
    const created = { id: `emp-new-${employees.length}`, name: body.name || template?.name, role: template?.role ?? body.role, objective: template?.objective ?? body.objective, status: body.templateSlug ? "draft" : "draft", autonomyMode: "supervised" };
    employees.unshift(created);
    return json({ employee: created }, 201);
  }
  if (url.pathname.startsWith("/api/agents/employees/")) return json({ scopes: { connection: [] }, openWork: 0, employee: employees.find((row) => url.pathname.endsWith(row.id)) });
  if (url.pathname === "/api/agents/tasks") return json({ tasks: TASKS });
  if (url.pathname === "/api/agents/approvals") return json({ approvals: [] });
  if (url.pathname === "/api/integrations") return json({ providers: [] });
  return json({});
};

// The app shell reveals [data-reveal] sections on scroll; the harness has no shell.
const reveal = document.createElement("style");
reveal.textContent = "[data-reveal]{opacity:1!important;transform:none!important;filter:none!important}";
document.head.appendChild(reveal);
if (params.get("theme") === "dark") document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(
  <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
    <main className="view-wrap setup-view" style={{ padding: 24, minHeight: "100vh", background: "var(--canvas, var(--surface-soft))" }}>
      <EmployeeDirectory />
    </main>
  </NextIntlClientProvider>,
);
