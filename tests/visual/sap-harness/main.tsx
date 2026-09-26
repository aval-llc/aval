/** Real Aval components; local UI fixtures only. No SAP or model traffic. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import es from "@/messages/es-mx.json";
import { IntegrationsCatalog } from "@/app/components/integrations-catalog";
import { ConnectionDialog, type Provider } from "@/app/components/connection-dialog";
import { ExperienceProvider } from "@/app/components/experience";
import { getProvider } from "@/lib/integrations/catalog";
import "@/app/globals.css";
import "@/app/enterprise.css";

const params = new URLSearchParams(location.search);
const locale = params.get("locale") === "es-mx" ? "es-mx" : "en";
let verified = false;
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (url.origin !== location.origin) throw new Error("UI fixture forbids external traffic");
  if (url.pathname === "/api/integrations/connect") {
    const body = JSON.parse(String(init?.body));
    if (Object.values(body.credentials).some(value => !value)) return Response.json({ error: "Missing required credentials" }, { status: 400 });
    return Response.json({ connection: { id: "simulated-connection" } });
  }
  if (url.pathname === "/api/integrations/verify") {
    if (params.has("failure")) return Response.json({ error: "ByDesign read failed: UNAUTHORIZED" }, { status: 422 });
    verified = true;
    return Response.json({ connection: { externalAccountName: "SIMULATED SAP" } });
  }
  return Response.json({ sources: [], canRefresh: false, canManageAutomatic: false, connections: [], runs: [], providers: [] });
};

function Harness() {
  const [open, setOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const provider: Provider = { ...getProvider("sap_bydesign")!, configured: true,
    readiness: { sync: false, verification: true }, connection: connected ? { id: "simulated-connection", status: "connected" } : null };
  return <ExperienceProvider>
    <p style={{ padding: 16 }}>LOCAL UI TEST — simulated SAP responses</p>
    <IntegrationsCatalog providers={[provider]} loading={false} onOpen={() => setOpen(true)} />
    {open && <ConnectionDialog provider={provider} onClose={() => setOpen(false)} onRefresh={() => setConnected(verified)} />}
  </ExperienceProvider>;
}
document.documentElement.lang = locale;
const { Catalog, ConnectionDialog: dialogMessages, ConnectionOperations } = locale === "en" ? en : es;
createRoot(document.getElementById("root")!).render(<NextIntlClientProvider locale={locale} messages={{ Catalog, ConnectionDialog: dialogMessages, ConnectionOperations }} timeZone="UTC"><Harness /></NextIntlClientProvider>);
