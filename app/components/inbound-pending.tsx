"use client";
import { useEffect, useState } from "react";
type Pending = { id: string; status: string; reason: string; contact: string };
type Choice = { residentId: string; leaseId: string; name: string; property: string; unit: string };
export function InboundPending() {
  const [data, setData] = useState<{ pending: Pending[]; choices: Choice[]; canResolve: boolean } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch("/api/communications/pending", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Pending intake unavailable");
        setData(await response.json()); setError("");
      } catch { if (!controller.signal.aborted) setError("Pending intake could not be loaded"); }
    };
    void load(); const timer = setInterval(() => void load(), 30000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [revision]);
  async function resolve(id: string, selection: string) {
    if (!selection || busy) return;
    const choice = data?.choices.find(c => `${c.residentId}:${c.leaseId}` === selection);
    if (!choice) return;
    setBusy(true);
    try {
      const response = await fetch("/api/communications/pending", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, residentId: choice.residentId, leaseId: choice.leaseId }) });
      const body = await response.json() as { error?: string }; if (!response.ok) throw new Error(body.error ?? "Resolution failed");
      setRevision(n => n + 1);
    } catch (e) { setError(e instanceof Error ? e.message : "Resolution failed"); }
    finally { setBusy(false); }
  }
  return <section className="settings-card" aria-label="Pending inbound requests">
    <h3>Pending intake {data ? `(${data.pending.length})` : ""}</h3>
    {error && <p role="alert">{error}</p>}
    {data?.pending.length === 0 && <p className="settings-muted">No deferred requests.</p>}
    {data?.pending.map(item => <div key={item.id}><strong>{item.contact}</strong><p>{item.status.replaceAll("_", " ")} · {item.reason}</p>
      {item.status === "review_required" && data.canResolve && <form onSubmit={e => { e.preventDefault(); void resolve(item.id, String(new FormData(e.currentTarget).get("match") ?? "")); }}>
        <label>Resident and active lease <select name="match" required defaultValue=""><option value="" disabled>Choose a verified match</option>{data.choices.map(c => <option key={`${c.residentId}:${c.leaseId}`} value={`${c.residentId}:${c.leaseId}`}>{c.name} · {c.property} · {c.unit}</option>)}</select></label>
        <button className="soft-button" disabled={busy} type="submit">Confirm match</button>
      </form>}
    </div>)}
  </section>;
}
