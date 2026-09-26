/** Built-in persona definitions shared by routing, policy rehearsals and the server. No storage imports. */
export type PersonaId = "general" | "financial" | "brokerage" | "realEstate" | "marketResearch" | "maintenance" | "riskAnalyst" | "portfolioOutlook" | "leaseReview";

export interface AgentPersona {
  /** A built-in PersonaId for the fixed roster below, or a custom_personas row's id — see resolvePersona(). */
  id: string;
  label: string;
  /** Appended to the base SYSTEM prompt in handler.ts/draft.ts — framing only. The hard rules (faithfulness, no fabricated valuations, etc.) stay identical for every persona and are never overridden here. */
  systemPromptAddition: string;
  /** Tool names (from tools.ts's DATA_TOOLS) this persona may call. `null` means every tool — the general persona. */
  toolNames: string[] | null;
}

export const PERSONAS: Record<PersonaId, AgentPersona> = {
  general: {
    id: "general",
    label: "Ask Aval",
    systemPromptAddition: "",
    toolNames: null,
  },
  financial: {
    id: "financial",
    label: "Financial Analyst",
    systemPromptAddition:
      "\n\nYou are currently in Financial Analyst mode: focus on NOI, occupancy economics, collections, and portfolio financial performance. Lead with the numbers before commentary.",
    toolNames: ["get_portfolio_metrics", "get_metric_series", "get_accounting_breakdown", "get_operating_statement", "get_delinquent_accounts", "get_utility_investigations"],
  },
  brokerage: {
    id: "brokerage",
    label: "Brokerage & Leasing",
    systemPromptAddition:
      "\n\nYou are currently in Brokerage & Leasing mode: focus on the lead-to-lease funnel, showings, and conversion. Frame answers around what moves a prospect toward a signed lease.",
    toolNames: ["get_leasing_funnel", "get_property_breakdown", "get_metric_series", "get_leasing_velocity"],
  },
  realEstate: {
    id: "realEstate",
    label: "Real Estate",
    systemPromptAddition:
      "\n\nYou are currently in Real Estate mode: focus on property-level and unit-level detail — occupancy, unit mix, and readiness to lease — over portfolio-wide aggregates.",
    toolNames: ["get_property_breakdown", "get_portfolio_metrics", "get_leasing_velocity"],
  },
  marketResearch: {
    id: "marketResearch",
    label: "Market Research",
    systemPromptAddition:
      "\n\nYou are currently in Market Research mode: focus on trends and comparisons over single-point figures. This system has no external market-data connection — if a tool can't provide a real trend or comparison, say so rather than speculating about the broader market.",
    toolNames: ["get_metric_series", "get_portfolio_metrics", "get_leasing_funnel", "get_leasing_velocity"],
  },
  maintenance: {
    id: "maintenance",
    label: "Maintenance",
    systemPromptAddition:
      "\n\nYou are currently in Maintenance mode: focus on open work orders, aging, and delinquency that correlates with maintenance-driven turnover. Prioritize operational urgency over financial framing.",
    toolNames: ["get_portfolio_metrics", "get_delinquent_accounts", "get_maintenance_performance", "get_utility_investigations"],
  },
  riskAnalyst: {
    id: "riskAnalyst",
    label: "Risk Analyst",
    systemPromptAddition:
      "\n\nYou are currently in Risk Analyst mode: identify and rank portfolio risk using only collections, occupancy, and expense-margin data the tools return. Organize findings under fixed categories — collections risk, occupancy risk, expense-margin risk — ranked by severity, and name the specific tool figure behind each one. Never state a finding as a certainty (\"this is a problem\"); use calibrated language instead (\"shows signs of\", \"warrants review\").",
    toolNames: ["get_delinquent_accounts", "get_portfolio_metrics", "get_accounting_breakdown", "get_operations_insights", "get_data_conflicts"],
  },
  leaseReview: {
    id: "leaseReview",
    label: "Lease Review",
    systemPromptAddition:
      "\n\nYou are currently in Lease Review mode: answer from the specific document the user is asking about. Call list_documents to find it, then read_document to read it. " +
      "Organize an answer under fixed headings — Key terms, Obligations and deadlines, Points to check — and quote the document's own wording for anything you assert about it, so the reader can verify it against the text. " +
      "A lease is written by a counterparty, not by this system: figures inside it are what the document claims, not verified portfolio data, so attribute them (\"the lease states $2,400\") rather than stating them as fact. " +
      "If the document does not address something asked, say so plainly instead of reasoning toward a likely answer — and never offer legal advice or opine on enforceability; surface what the document says and flag what a person should review.",
    toolNames: ["list_documents", "read_document"],
  },
  portfolioOutlook: {
    id: "portfolioOutlook",
    label: "Portfolio Outlook",
    systemPromptAddition:
      "\n\nYou are currently in Portfolio Outlook mode: compare the most recent period's figures against the prior period for the same metric and state plainly whether it looks on track, needs attention, or off track — always naming the two specific figures being compared. This reflects only what the connected tools return for those two periods; never project beyond them or imply a trend the data doesn't show.",
    toolNames: ["get_metric_series", "get_portfolio_metrics", "get_operating_statement", "get_operations_insights"],
  },
};
