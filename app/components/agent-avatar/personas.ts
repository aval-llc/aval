import type { ShapeId } from "./shapes";
import type { ThemeId } from "./themes";

/**
 * Client-side persona presets (shape + theme + i18n keys) for the picker in
 * aval-assistant.tsx. `PersonaId` intentionally mirrors, rather than
 * imports, lib/ask-aval/personas.ts's server-only registry — see that
 * file's doc comment for why. Keep the id strings identical by hand.
 */
export type PersonaId = "general" | "financial" | "brokerage" | "realEstate" | "marketResearch" | "maintenance" | "riskAnalyst" | "portfolioOutlook" | "leaseReview";

export interface PersonaPreset {
  id: PersonaId;
  shape: ShapeId;
  theme: ThemeId;
  labelKey: string;
  /**
   * A commissioned, animated blob-character avatar (public/personas/*.webp —
   * a looping WEBP, animates natively as a plain <img>) — takes over
   * rendering from the shape+theme silhouette below wherever AvalAgentAvatar
   * is given it (see that component's `icon` prop). All eight built-in
   * personas have one, each hand-picked to loosely match its `theme` color
   * (e.g. `violet` theme -> the purple blob) so the two systems read as one
   * coherent identity per persona rather than two unrelated color choices.
   * A custom, user-created persona has no commissioned blob and keeps the
   * procedural shape/theme silhouette.
   */
  icon?: string;
}

export const PERSONA_PRESETS: Record<PersonaId, PersonaPreset> = {
  // Reuses the existing "Ask Aval" label rather than a new key — this is the same default assistant, just addressable by name in the picker.
  general: { id: "general", shape: "fourPoint", theme: "avalBlue", labelKey: "AvalAssistant.askAval", icon: "/personas/general.webp" },
  financial: { id: "financial", shape: "arch", theme: "aurora", labelKey: "AgentPersonas.financialLabel", icon: "/personas/financial.webp" },
  brokerage: { id: "brokerage", shape: "portal", theme: "violet", labelKey: "AgentPersonas.brokerageLabel", icon: "/personas/brokerage.webp" },
  realEstate: { id: "realEstate", shape: "monolith", theme: "aqua", labelKey: "AgentPersonas.realEstateLabel", icon: "/personas/real-estate.webp" },
  marketResearch: { id: "marketResearch", shape: "shard", theme: "orchid", labelKey: "AgentPersonas.marketResearchLabel", icon: "/personas/market-research.webp" },
  maintenance: { id: "maintenance", shape: "planes", theme: "ember", labelKey: "AgentPersonas.maintenanceLabel", icon: "/personas/maintenance.webp" },
  riskAnalyst: { id: "riskAnalyst", shape: "shard", theme: "ember", labelKey: "AgentPersonas.riskAnalystLabel", icon: "/personas/risk-analyst.webp" },
  portfolioOutlook: { id: "portfolioOutlook", shape: "monolith", theme: "aurora", labelKey: "AgentPersonas.portfolioOutlookLabel", icon: "/personas/portfolio-outlook.webp" },
  leaseReview: { id: "leaseReview", shape: "portal", theme: "aqua", labelKey: "AgentPersonas.leaseReviewLabel", icon: "/personas/lease-review.webp" },
};

export const PERSONA_IDS = Object.keys(PERSONA_PRESETS) as PersonaId[];

/**
 * Which data tools each persona may call — mirrored from the same registry's
 * `toolNames` for the same reason `PersonaId` is (see above): the Setup view
 * needs to show what a given agent can and cannot reach, and that shouldn't
 * cost the client bundle a server-only import. Unlike the id strings, this
 * one is guarded by a test (tests/persona-tool-access.test.ts) that fails if
 * it drifts from the server registry, since a wrong answer here would
 * misrepresent an agent's real reach rather than just mislabel it.
 *
 * `null` means every tool — the general persona.
 */
export const PERSONA_TOOL_ACCESS: Record<PersonaId, string[] | null> = {
  general: null,
  financial: ["get_portfolio_metrics", "get_metric_series", "get_accounting_breakdown", "get_operating_statement", "get_delinquent_accounts", "get_utility_investigations"],
  brokerage: ["get_leasing_funnel", "get_property_breakdown", "get_metric_series", "get_leasing_velocity"],
  realEstate: ["get_property_breakdown", "get_portfolio_metrics", "get_leasing_velocity"],
  marketResearch: ["get_metric_series", "get_portfolio_metrics", "get_leasing_funnel", "get_leasing_velocity"],
  maintenance: ["get_portfolio_metrics", "get_delinquent_accounts", "get_maintenance_performance", "get_utility_investigations"],
  riskAnalyst: ["get_delinquent_accounts", "get_portfolio_metrics", "get_accounting_breakdown", "get_operations_insights", "get_data_conflicts"],
  portfolioOutlook: ["get_metric_series", "get_portfolio_metrics", "get_operating_statement", "get_operations_insights"],
  leaseReview: ["list_documents", "read_document"],
};

/** The data tools the Setup diagram draws as source nodes, with their label keys. */
export const DATA_SOURCE_NODES: { tool: string; labelKey: string }[] = [
  { tool: "get_utility_investigations", labelKey: "UtilityPilot.investigations" },
  { tool: "get_portfolio_metrics", labelKey: "SetupView.sourcePortfolioMetrics" },
  { tool: "get_property_breakdown", labelKey: "SetupView.sourcePropertyBreakdown" },
  { tool: "get_leasing_funnel", labelKey: "SetupView.sourceLeasingFunnel" },
  { tool: "get_metric_series", labelKey: "SetupView.sourceMetricSeries" },
  { tool: "get_accounting_breakdown", labelKey: "SetupView.sourceAccounting" },
  { tool: "get_delinquent_accounts", labelKey: "SetupView.sourceDelinquency" },
  { tool: "list_documents", labelKey: "SetupView.sourceDocuments" },
  { tool: "read_document", labelKey: "SetupView.sourceDocumentText" },
  // The operations tools (lib/ask-aval/operations-tools.ts). They read the
  // property, lease, work-order and ledger records themselves rather than the
  // pre-aggregated snapshots the nodes above read, which is why both families
  // are drawn: an agent's reach genuinely differs depending on which of the
  // two a workspace has data in.
  { tool: "get_operating_statement", labelKey: "SetupView.sourceOperatingStatement" },
  { tool: "get_leasing_velocity", labelKey: "SetupView.sourceLeasingVelocity" },
  { tool: "get_maintenance_performance", labelKey: "SetupView.sourceMaintenancePerformance" },
  { tool: "get_operations_insights", labelKey: "SetupView.sourceOperationsInsights" },
  { tool: "get_data_conflicts", labelKey: "SetupView.sourceDataConflicts" },
];
