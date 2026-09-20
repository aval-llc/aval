import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const userOnboarding = sqliteTable("user_onboarding", {
  userId: text("user_id").notNull(),
  organizationId: text("organization_id").notNull(),
  preferences: text("preferences").notNull(),
  step: integer("step").notNull().default(0),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  introSeen: integer("intro_seen", { mode: "boolean" }).notNull().default(false),
  revision: integer("revision").notNull().default(1),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("user_onboarding_user_org_uq").on(table.userId, table.organizationId)]);

// Supports both password accounts and platform identities, which need not
// have a row in users. The API always derives user_id from the session.
export const userAppearance = sqliteTable("user_appearance", {
  userId: text("user_id").primaryKey(),
  preferences: text("preferences").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// Real customer accounts for deployments outside ChatGPT Sites, where there
// is no platform-injected identity header — email/password, hashed with
// PBKDF2 (lib/auth/password.ts), never stored or logged in plain text.
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("users_email_uq").on(table.email)],
);

// Stable application identities. Supabase, ChatGPT, and future enterprise SSO
// subjects link here; identities are never merged by email alone.
export const principals = sqliteTable("principals", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull().default("human"),
  displayName: text("display_name").notNull(),
  primaryEmail: text("primary_email"),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [check("principals_kind_ck", sql`${table.kind} in ('human','service')`)]);

export const identityLinks = sqliteTable("identity_links", {
  id: text("id").primaryKey(),
  principalId: text("principal_id").notNull().references(() => principals.id),
  provider: text("provider").notNull(),
  subject: text("subject").notNull(),
  emailAtLink: text("email_at_link"),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
}, (table) => [
  uniqueIndex("identity_links_provider_subject_uq").on(table.provider, table.subject),
  index("identity_links_principal_idx").on(table.principalId),
]);

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ownerUserId: text("owner_user_id").notNull(),
  // Which connected model-provider ProviderId (integration_connections.provider,
  // category "Model") powers agents/Ask Aval for this org. Null means model
  // features are paused until a provider is connected and selected.
  activeModelProvider: text("active_model_provider"),
  // Which persona (a built-in PersonaId or a custom_personas row's id) Ask
  // Aval opens with by default for this org — set from Settings → Aval
  // Setup. Null means the built-in "general" persona, matching this app's
  // behavior before this column existed.
  defaultPersonaId: text("default_persona_id"),
  // The seat slug currently shown to this workspace — its address is
  // `agent-{seatSlug}@aval.llc`. Null until an operator picks one during setup;
  // a workspace without one has no inbound seat and no PMS can mail it.
  //
  // This is the *current* address, not the set of addresses that reach here.
  // Renaming adds a slug rather than replacing one, because a customer's PMS
  // already has the old address on file and nothing we do should make mail they
  // send disappear. `organization_seat_slugs` is that permanent set, and every
  // value here must also exist there.
  seatSlug: text("seat_slug"),
  // How many AI employees this workspace may have. Null means no limit, which
  // is the architecture's own position: a ceiling is a commercial decision, not
  // a property of the runtime, so nothing below this column assumes a number.
  aiEmployeeLimit: integer("ai_employee_limit"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("organizations_seat_slug_uq").on(table.seatSlug)]);

export const ssoConnections = sqliteTable("sso_connections", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  supabaseProviderId: text("supabase_provider_id"),
  permittedDomainsJson: text("permitted_domains_json").notNull().default("[]"),
  enforcement: text("enforcement").notNull().default("disabled"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("sso_connections_org_uq").on(table.organizationId),
  check("sso_connections_enforcement_ck", sql`${table.enforcement} in ('disabled','optional','required')`),
]);

/**
 * Who belongs to a workspace, and what they may do in it.
 *
 * Until this existed, `organizationIdForUser` hashed a user id into a
 * workspace, so every account was alone in its own. Two controls depended on a
 * second person who could not exist: the elevated approval tier requires two
 * distinct approvers, and separation of duties forbids the requester from
 * approving a critical action. Both failed closed — safe, but it meant the
 * approval gate could never open for the actions it exists to gate.
 *
 * A user's personal workspace is still `org_<hash(userId)>` and is not
 * migrated; membership is additive. A row here is what lets someone act in a
 * workspace that is not their own.
 */
export const organizationMembers = sqliteTable(
  "organization_members",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    userId: text("user_id").notNull().references(() => users.id),
    // owner: policy, invitations, membership, approvals.
    // approver: approvals, plus everything a member may do.
    // member: run agents and read; never decides an approval.
    role: text("role").notNull(),
    invitedByUserId: text("invited_by_user_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    // One membership per person per workspace. This is also what makes
    // "two distinct approvers" countable rather than a matter of trust.
    uniqueIndex("organization_members_org_user_uq").on(table.organizationId, table.userId),
    index("organization_members_user_idx").on(table.userId),
  ],
);

/**
 * An outstanding invitation to a workspace.
 *
 * There is no email service in this deployment, so the code is shown to the
 * inviter once and shared out of band. Only its hash is stored: an invitation
 * grants standing access to a tenant's data, which makes it a credential, and
 * a credential readable from a database row is one a database read can steal.
 */
export const organizationInvitations = sqliteTable(
  "organization_invitations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    codeHash: text("code_hash").notNull(),
    role: text("role").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    acceptedByUserId: text("accepted_by_user_id"),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    // The lookup is by hash, and uniqueness stops one code being redeemed
    // twice through concurrent requests.
    uniqueIndex("organization_invitations_code_uq").on(table.codeHash),
    index("organization_invitations_org_idx").on(table.organizationId, table.createdAt),
  ],
);

export const integrationConnections = sqliteTable(
  "integration_connections",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    provider: text("provider").notNull(),
    category: text("category").notNull(),
    status: text("status").notNull().default("pending"),
    authMode: text("auth_mode").notNull(),
    externalAccountId: text("external_account_id"),
    externalAccountName: text("external_account_name"),
    scopesJson: text("scopes_json").notNull().default("[]"),
    accessTokenCiphertext: text("access_token_ciphertext"),
    refreshTokenCiphertext: text("refresh_token_ciphertext"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    metadataJson: text("metadata_json").notNull().default("{}"),
    lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("integration_connections_org_provider_uq").on(table.organizationId, table.provider),
    index("integration_connections_org_status_idx").on(table.organizationId, table.status),
  ],
);

export const oauthStates = sqliteTable(
  "oauth_states",
  {
    state: text("state").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    provider: text("provider").notNull(),
    userId: text("user_id").notNull(),
    codeVerifier: text("code_verifier"),
    returnTo: text("return_to").notNull().default("/?view=connections"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("oauth_states_expiry_idx").on(table.expiresAt)],
);

export const integrationEvents = sqliteTable(
  "integration_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id"),
    connectionId: text("connection_id").references(() => integrationConnections.id),
    provider: text("provider").notNull(),
    externalEventId: text("external_event_id").notNull(),
    eventType: text("event_type").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull().default("received"),
    receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
    processedAt: integer("processed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("integration_events_provider_external_uq").on(table.provider, table.externalEventId),
    index("integration_events_provider_status_idx").on(table.provider, table.status),
  ],
);

export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    connectionId: text("connection_id").notNull().references(() => integrationConnections.id),
    provider: text("provider").notNull(),
    status: text("status").notNull().default("queued"),
    cursorJson: text("cursor_json").notNull().default("{}"),
    countsJson: text("counts_json").notNull().default("{}"),
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("sync_runs_connection_started_idx").on(table.connectionId, table.startedAt)],
);

/** Durable, opt-in import scheduling and per-connection worker lease. */
export const integrationSyncState = sqliteTable("integration_sync_state", {
  connectionId: text("connection_id").primaryKey().references(() => integrationConnections.id),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  externalAccountId: text("external_account_id").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  cursorJson: text("cursor_json").notNull().default("{}"),
  nextRunAt: integer("next_run_at", { mode: "timestamp_ms" }).notNull(),
  leaseToken: text("lease_token"),
  leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
  attempts: integer("attempts").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [index("integration_sync_due_idx").on(table.enabled, table.nextRunAt)]);

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    channel: text("channel").notNull(),
    externalThreadId: text("external_thread_id").notNull(),
    contactDisplayName: text("contact_display_name").notNull(),
    status: text("status").notNull().default("open"),
    locale: text("locale").notNull().default("en"),
    register: text("register").notNull().default("professional"),
    // A reply Ask Aval drafted the moment the latest inbound message arrived
    // (lib/ask-aval/auto-reply.ts), pre-filled in the Inbox composer for a
    // human to edit or send. Never sent automatically — see draftReplyStatus.
    draftReply: text("draft_reply"),
    draftReplyStatus: text("draft_reply_status"),
    draftReplyAt: integer("draft_reply_at", { mode: "timestamp_ms" }),
    lastMessageAt: integer("last_message_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("conversations_org_channel_external_uq").on(table.organizationId, table.channel, table.externalThreadId),
    index("conversations_org_status_idx").on(table.organizationId, table.status),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull().references(() => conversations.id),
    externalMessageId: text("external_message_id").notNull(),
    direction: text("direction").notNull(),
    body: text("body").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("messages_conversation_external_uq").on(table.conversationId, table.externalMessageId),
    index("messages_conversation_created_idx").on(table.conversationId, table.createdAt),
  ],
);

export const portfolioSnapshots = sqliteTable(
  "portfolio_snapshots",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    source: text("source").notNull(),
    metricKey: text("metric_key").notNull(),
    numericValue: integer("numeric_value"),
    textValue: text("text_value"),
    periodStart: integer("period_start", { mode: "timestamp_ms" }),
    periodEnd: integer("period_end", { mode: "timestamp_ms" }),
    capturedAt: integer("captured_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("portfolio_snapshots_org_captured_idx").on(table.organizationId, table.capturedAt)],
);

export const funnelSnapshots = sqliteTable(
  "funnel_snapshots",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    source: text("source").notNull(),
    stage: text("stage").notNull(),
    count: integer("count").notNull(),
    capturedAt: integer("captured_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("funnel_snapshots_org_captured_idx").on(table.organizationId, table.capturedAt)],
);

// Ask Aval's daily spend guard: one row per model call, so a per-org daily
// cap can be enforced by counting rows for today rather than trusting an
// in-memory counter that a Worker isolate wouldn't reliably persist anyway.
export const aiUsage = sqliteTable(
  "ai_usage",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    userId: text("user_id").notNull(),
    day: text("day").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("ai_usage_org_day_idx").on(table.organizationId, table.day)],
);

// One row per org, tracking its current Stripe subscription. planId is a
// key into lib/billing/plans.ts's PLANS array, not a foreign key: plans are
// defined in code, not the database, since they change by editing that
// file rather than running a migration.
export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    planId: text("plan_id").notNull(),
    status: text("status").notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    currentPeriodStart: integer("current_period_start", { mode: "timestamp_ms" }),
    currentPeriodEnd: integer("current_period_end", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("subscriptions_org_uq").on(table.organizationId)],
);

// One row per completed one-time "buy more tokens" purchase. Token balance
// is the sum of tokensGranted across all rows for an org, not a running
// counter column, so a webhook retried by Stripe (deduplicated on
// stripeSessionId) can never double- or under-credit a purchase.
export const tokenTopUps = sqliteTable(
  "token_top_ups",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    stripeSessionId: text("stripe_session_id").notNull(),
    packId: text("pack_id").notNull(),
    tokensGranted: integer("tokens_granted").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("token_top_ups_session_uq").on(table.stripeSessionId)],
);

// Every finished (or failed) Ask Aval Tasks draft, so a refresh doesn't lose
// it — the client's draft-job state is otherwise purely in-memory.
export const draftDocuments = sqliteTable(
  "draft_documents",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    userId: text("user_id").notNull(),
    title: text("title").notNull(),
    instructions: text("instructions").notNull(),
    format: text("format").notNull(),
    status: text("status").notNull(),
    headline: text("headline"),
    narrative: text("narrative"),
    documentType: text("document_type"),
    documentMarkdown: text("document_markdown"),
    metricsJson: text("metrics_json").notNull().default("[]"),
    chartJson: text("chart_json"),
    confidence: text("confidence"),
    errorMessage: text("error_message"),
    sentTo: text("sent_to"),
    moduleLabel: text("module_label"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("draft_documents_org_created_idx").on(table.organizationId, table.createdAt)],
);

// A structured, redacted workflow preference — never raw tenant/financial
// content — that Ask Aval reads back as context. See
// lib/ask-aval/preferences.ts for what is and isn't allowed to land here.
export const learnedPreferences = sqliteTable(
  "learned_preferences",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    topic: text("topic").notNull(),
    statement: text("statement").notNull(),
    source: text("source").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("learned_preferences_org_topic_uq").on(table.organizationId, table.topic),
    index("learned_preferences_org_idx").on(table.organizationId),
  ],
);

// One run per triggered automation (e.g. a maintenance issue routed to a
// vendor). insightId ties back to the real sample insight that triggered
// it — no synthetic trigger data.
export const automationRuns = sqliteTable(
  "automation_runs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    insightId: text("insight_id").notNull(),
    status: text("status").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("automation_runs_org_created_idx").on(table.organizationId, table.createdAt)],
);

// Each timeline entry within a run, in order.
export const automationSteps = sqliteTable(
  "automation_steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => automationRuns.id),
    kind: text("kind").notNull(),
    actorLabel: text("actor_label").notNull(),
    summary: text("summary").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("automation_steps_run_idx").on(table.runId)],
);

// One row per rate-limited attempt (signup, login), never per-window —
// counted by querying rows within the window, the same idiom ai_usage
// already uses for the daily model-call cap, so the limiter needs no
// separate counter that a Worker isolate wouldn't reliably persist anyway.
// scopeKey encodes both the action and the identity being limited (e.g.
// "signup:ip:203.0.113.4" or "login:email:a@b.com") so IP-based and
// account-based limits can coexist without cross-contaminating.
export const rateLimitHits = sqliteTable(
  "rate_limit_hits",
  {
    id: text("id").primaryKey(),
    scopeKey: text("scope_key").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("rate_limit_hits_scope_created_idx").on(table.scopeKey, table.createdAt)],
);

// One row per approve/deny/send decision on an actionable insight — the
// richest real usage signal in the app, previously only client-side state
// that vanished on refresh and was invisible to Ask Aval. insightId and
// decision are both from a small fixed set (never free text), so this
// stays as privacy-safe as learned_preferences by construction, not by
// filtering: there is no field here a tenant name or dollar amount could
// end up in. See lib/ask-aval/usage-patterns.ts for how this is read back.
export const insightDecisions = sqliteTable(
  "insight_decisions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    insightId: text("insight_id").notNull(),
    decision: text("decision").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("insight_decisions_org_insight_idx").on(table.organizationId, table.insightId)],
);

// A physical (or, pre-connection, manually tracked) electricity/water/gas
// meter. There is no `properties`/`units` table yet — see docs/DECISIONS.md
// — so meters are scoped to the org with a free-text property/unit label,
// the same shape `insightDecisions` uses above for referencing a sample-data
// id that doesn't have a real table behind it yet. Once a real property
// table exists, propertyLabel/unitLabel should become propertyId/unitId.
export const utilityMeters = sqliteTable(
  "utility_meters",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    utilityType: text("utility_type").notNull(), // "electricity" | "water" | "gas"
    propertyLabel: text("property_label").notNull(),
    unitLabel: text("unit_label"),
    meterNumber: text("meter_number"),
    provider: text("provider"),
    unitOfMeasure: text("unit_of_measure").notNull(), // "kWh" | "gal" | "ccf" | "therm" | "m3"
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("utility_meters_org_type_idx").on(table.organizationId, table.utilityType)],
);

// One row per billing-period read for a meter. usageAmount is a `real`
// column since utility usage is fractional (1,234.56 kWh); costCents stays
// an integer, matching how money is stored everywhere else in this schema
// (see `tokenTopUps`, billing) — see lib/finance/money.ts for the
// dinero.js-backed arithmetic that operates on it.
export const utilityBills = sqliteTable(
  "utility_bills",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    meterId: text("meter_id").notNull().references(() => utilityMeters.id),
    periodStart: integer("period_start", { mode: "timestamp_ms" }).notNull(),
    periodEnd: integer("period_end", { mode: "timestamp_ms" }).notNull(),
    usageAmount: real("usage_amount").notNull(),
    costCents: integer("cost_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    source: text("source").notNull(), // "manual" | "ai_extracted"
    extractionConfidence: text("extraction_confidence"), // set only when source is "ai_extracted"
    extractionNote: text("extraction_note"), // model's own caveat about the extraction, shown to the user, never trusted silently
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("utility_bills_org_period_idx").on(table.organizationId, table.periodStart),
    index("utility_bills_meter_period_idx").on(table.meterId, table.periodStart),
  ],
);

// A workspace-defined Ask Aval persona, alongside the fixed built-in roster
// in lib/ask-aval/personas.ts (general/financial/brokerage/realEstate/
// marketResearch/maintenance). focusDescription becomes a system-prompt
// *addition*, never a replacement — see lib/ask-aval/custom-personas.ts for
// why an operator-authored focus can't be used to bypass the faithfulness
// gate or reach a tool outside toolNamesJson, regardless of its wording.
export const agentPersonas = sqliteTable(
  "agent_personas",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    label: text("label").notNull(),
    focusDescription: text("focus_description").notNull(),
    toolNamesJson: text("tool_names_json"), // JSON string array, or null meaning "every tool" (matches AgentPersona.toolNames)
    shape: text("shape").notNull(), // ShapeId, app/components/agent-avatar/shapes.tsx
    theme: text("theme").notNull(), // ThemeId, app/components/agent-avatar/themes.ts
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("agent_personas_org_idx").on(table.organizationId)],
);

// A tamper-evident record of what Ask Aval did to produce each answer: which
// tools ran, whether the faithfulness gate passed, and a digest of the answer.
// Each row commits to the previous row's hash (see lib/audit/chain.ts), so the
// trail can be re-verified and any edit, deletion or reordering surfaces.
//
// Deliberately stores DIGESTS, not payloads. Tool results carry resident names
// and balances; keeping them here would make this table a second, indefinitely
// retained copy of the most sensitive data in the app. `label` holds only a
// tool name or a gate outcome, and `count` only a magnitude — neither is
// identifying. Same trade as learned_preferences: keep the structure, drop the
// content.
export const answerAuditLog = sqliteTable(
  "answer_audit_log",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    // 1-based, contiguous per organization — a gap is itself evidence.
    sequence: integer("sequence").notNull(),
    kind: text("kind").notNull(), // AuditEntryKind
    label: text("label").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    count: integer("count").notNull(),
    previousHash: text("previous_hash").notNull(),
    entryHash: text("entry_hash").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    // Enforces contiguity at the database level: two concurrent runs cannot
    // both claim the same position, so a race fails loudly instead of forking
    // the chain into two branches that each look valid alone.
    uniqueIndex("answer_audit_log_org_sequence_uq").on(table.organizationId, table.sequence),
    index("answer_audit_log_org_idx").on(table.organizationId),
  ],
);

// Documents a workspace pastes in for Aval to read: leases, owner and lender
// statements, vendor estimates. This is the ingestion layer two deferred agent
// ideas needed (docs/DECISIONS.md) — document financial extraction, and a
// lease-review persona that can answer about a specific contract.
//
// Unlike learned_preferences and answer_audit_log, this table DOES hold raw
// third-party text, because that is the whole point: you cannot review a lease
// without the lease. The controls are therefore explicit rather than
// structural — org scoping like every other row, a hard size cap, and
// user-initiated deletion — and `lib/ask-aval/handler.ts`'s standing rule that
// tool output is data and never instructions matters more here than anywhere
// else, since a lease is authored by someone outside the workspace.
export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    title: text("title").notNull(),
    kind: text("kind").notNull(), // DocumentKind, lib/documents/types.ts
    contentText: text("content_text").notNull(),
    // Denormalized so the list view can show size without reading every body.
    charCount: integer("char_count").notNull(),
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("documents_org_idx").on(table.organizationId)],
);

export const ownershipEntities = sqliteTable("ownership_entities", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  legalName: text("legal_name"),
  externalId: text("external_id"),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("ownership_entities_org_id_uq").on(table.organizationId, table.id),
  uniqueIndex("ownership_entities_org_external_uq").on(table.organizationId, table.externalId),
]);

export const portfolios = sqliteTable("portfolios", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("portfolios_org_id_uq").on(table.organizationId, table.id),
  uniqueIndex("portfolios_org_name_uq").on(table.organizationId, table.name),
]);

export const regions = sqliteTable("regions", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  code: text("code"),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("regions_org_id_uq").on(table.organizationId, table.id),
  uniqueIndex("regions_org_code_uq").on(table.organizationId, table.code),
]);

/* ═══════════════════════════════════════════════════════════════════════════
 * OPERATIONS
 *
 * The canonical record layer behind the Operations module (Properties,
 * Leasing, Maintenance, Accounting). Until now this app stored only
 * `portfolio_snapshots` — a flat metric_key → number table — which can report
 * "occupancy is 94%" but cannot answer which unit type is slowest to lease,
 * which vendor misses its SLA, or who is 60 days past due. Those questions
 * need records, not pre-aggregated metrics, so these tables hold records and
 * every figure the app shows is computed from them (lib/operations/).
 *
 * Three decisions run through all of it:
 *
 * 1. ONE VOCABULARY, MANY SOURCES. A portfolio is rarely on one system —
 *    leasing in AppFolio, books in QuickBooks, work orders somewhere else.
 *    These tables are the normalized shape everything lands in, so figures
 *    aggregate across a mixed stack instead of per-connector. Field names
 *    follow the MITS/NMHC domains (Property-Marketing, Lease/Application,
 *    Resident Transactions, Lead Management) that the real connectors
 *    ultimately map from.
 *
 * 2. PROVENANCE ON EVERY ROW. `sourceProvider` + `externalId` say where a row
 *    came from ("manual" when a person typed it), and their unique index per
 *    org makes re-syncing an upsert rather than a duplicate. A number with no
 *    traceable origin is not something this app is willing to show.
 *
 * 3. DISAGREEMENTS ARE RECORDED, NEVER SILENTLY RESOLVED. When two connected
 *    systems report different values for the same field, `operations_conflicts`
 *    keeps both and flags it. Picking a winner invisibly is how a dashboard
 *    ends up confidently wrong — the same failure the faithfulness gate and
 *    audit chain exist to prevent, one layer lower down.
 *
 * Money is integer cents everywhere, matching the rest of this schema; see
 * lib/finance/money.ts for the arithmetic.
 * ═══════════════════════════════════════════════════════════════════════════ */

export const properties = sqliteTable(
  "properties",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    ownershipEntityId: text("ownership_entity_id").references(() => ownershipEntities.id),
    portfolioId: text("portfolio_id").references(() => portfolios.id),
    regionId: text("region_id").references(() => regions.id),
    name: text("name").notNull(),
    addressLine1: text("address_line1"),
    city: text("city"),
    region: text("region"),
    postalCode: text("postal_code"),
    country: text("country").notNull().default("US"),
    propertyType: text("property_type").notNull().default("multifamily"), // PropertyType, lib/operations/types.ts
    // What the source system *says* the unit count is, which is not always the
    // number of unit rows it actually delivered. Kept separate from the derived
    // count rather than reconciled on write: a mismatch is a real finding about
    // an incomplete sync, and overwriting one with the other would hide it.
    reportedUnitCount: integer("reported_unit_count"),
    yearBuilt: integer("year_built"),
    squareFeet: integer("square_feet"),
    // Present only where a source or the operator supplied them; cap-rate and
    // valuation math is skipped rather than estimated when they are null.
    acquisitionCostCents: integer("acquisition_cost_cents"),
    currentValueCents: integer("current_value_cents"),
    status: text("status").notNull().default("active"), // "active" | "inactive"
    sourceProvider: text("source_provider").notNull().default("manual"),
    sourceConnectionId: text("source_connection_id").references(() => integrationConnections.id),
    externalId: text("external_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("properties_org_id_uq").on(table.organizationId, table.id),
    uniqueIndex("properties_org_source_external_uq").on(table.organizationId, table.sourceProvider, table.externalId),
    index("properties_org_status_idx").on(table.organizationId, table.status),
    foreignKey({ columns: [table.organizationId, table.ownershipEntityId], foreignColumns: [ownershipEntities.organizationId, ownershipEntities.id], name: "properties_org_owner_fk" }),
    foreignKey({ columns: [table.organizationId, table.portfolioId], foreignColumns: [portfolios.organizationId, portfolios.id], name: "properties_org_portfolio_fk" }),
    foreignKey({ columns: [table.organizationId, table.regionId], foreignColumns: [regions.organizationId, regions.id], name: "properties_org_region_fk" }),
  ],
);

export const accessGrants = sqliteTable("access_grants", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  principalId: text("principal_id").notNull().references(() => principals.id),
  role: text("role").notNull(),
  organizationScope: integer("organization_scope", { mode: "boolean" }).notNull().default(false),
  ownershipEntityId: text("ownership_entity_id").references(() => ownershipEntities.id),
  portfolioId: text("portfolio_id").references(() => portfolios.id),
  regionId: text("region_id").references(() => regions.id),
  propertyId: text("property_id").references(() => properties.id),
  capabilitiesJson: text("capabilities_json").notNull().default("[]"),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  createdByPrincipalId: text("created_by_principal_id").references(() => principals.id),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("access_grants_org_id_uq").on(table.organizationId, table.id),
  index("access_grants_principal_org_idx").on(table.principalId, table.organizationId),
  index("access_grants_property_idx").on(table.organizationId, table.propertyId),
  check("access_grants_role_ck", sql`${table.role} in ('org_admin','regional_manager','property_manager','approver','operator','viewer','owner_viewer')`),
  check("access_grants_one_scope_ck", sql`
    (case when ${table.organizationScope} then 1 else 0 end) +
    (case when ${table.ownershipEntityId} is not null then 1 else 0 end) +
    (case when ${table.portfolioId} is not null then 1 else 0 end) +
    (case when ${table.regionId} is not null then 1 else 0 end) +
    (case when ${table.propertyId} is not null then 1 else 0 end) = 1
  `),
  foreignKey({ columns: [table.organizationId, table.ownershipEntityId], foreignColumns: [ownershipEntities.organizationId, ownershipEntities.id], name: "access_grants_org_owner_fk" }),
  foreignKey({ columns: [table.organizationId, table.portfolioId], foreignColumns: [portfolios.organizationId, portfolios.id], name: "access_grants_org_portfolio_fk" }),
  foreignKey({ columns: [table.organizationId, table.regionId], foreignColumns: [regions.organizationId, regions.id], name: "access_grants_org_region_fk" }),
  foreignKey({ columns: [table.organizationId, table.propertyId], foreignColumns: [properties.organizationId, properties.id], name: "access_grants_org_property_fk" }),
]);

export const approvalAuthorities = sqliteTable("approval_authorities", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  accessGrantId: text("access_grant_id").notNull().references(() => accessGrants.id),
  action: text("action").notNull(),
  currency: text("currency").notNull().default("USD"),
  maximumAmountCents: integer("maximum_amount_cents").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("approval_authorities_grant_action_currency_uq").on(table.accessGrantId, table.action, table.currency),
  check("approval_authorities_amount_ck", sql`${table.maximumAmountCents} >= 0`),
  foreignKey({ columns: [table.organizationId, table.accessGrantId], foreignColumns: [accessGrants.organizationId, accessGrants.id], name: "approval_authorities_org_grant_fk" }),
]);

export const units = sqliteTable(
  "units",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    propertyId: text("property_id").notNull().references(() => properties.id),
    unitNumber: text("unit_number").notNull(),
    bedrooms: integer("bedrooms"),
    bathrooms: real("bathrooms"), // real: 1.5-bath units are ordinary
    squareFeet: integer("square_feet"),
    // The asking rent for this unit today. Distinct from the rent on its
    // active lease, and the difference between them is loss-to-lease — a
    // figure operators care about that is invisible if only one is stored.
    marketRentCents: integer("market_rent_cents"),
    status: text("status").notNull().default("vacant_ready"), // UnitStatus, lib/operations/types.ts
    // Set when the unit last went vacant, so days-vacant is measured rather
    // than guessed. Null for a unit that has never turned over here.
    vacantSince: integer("vacant_since", { mode: "timestamp_ms" }),
    sourceProvider: text("source_provider").notNull().default("manual"),
    sourceConnectionId: text("source_connection_id").references(() => integrationConnections.id),
    externalId: text("external_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("units_org_source_external_uq").on(table.organizationId, table.sourceProvider, table.externalId),
    index("units_org_property_idx").on(table.organizationId, table.propertyId),
    index("units_org_status_idx").on(table.organizationId, table.status),
  ],
);

// A person on a lease or an application. Holds contact details because
// collections and leasing both need a channel to reach someone on — this is
// the one operations table carrying personal data, and it is org-scoped and
// never written into learned_preferences or the audit log (which store
// digests and tags precisely so they cannot become a second copy of this).
export const residents = sqliteTable(
  "residents",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    displayName: text("display_name").notNull(),
    email: text("email"),
    phone: text("phone"),
    status: text("status").notNull().default("current"), // ResidentStatus, lib/operations/types.ts
    sourceProvider: text("source_provider").notNull().default("manual"),
    sourceConnectionId: text("source_connection_id").references(() => integrationConnections.id),
    externalId: text("external_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("residents_org_source_external_uq").on(table.organizationId, table.sourceProvider, table.externalId),
    index("residents_org_status_idx").on(table.organizationId, table.status),
  ],
);

export const leases = sqliteTable(
  "leases",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    unitId: text("unit_id").notNull().references(() => units.id),
    propertyId: text("property_id").notNull().references(() => properties.id), // denormalized so portfolio rollups don't join through units
    status: text("status").notNull().default("active"), // LeaseStatus, lib/operations/types.ts
    startDate: integer("start_date", { mode: "timestamp_ms" }).notNull(),
    // Null for month-to-month, which is why isMonthToMonth exists separately:
    // a null end date otherwise reads identically to "we didn't get one".
    endDate: integer("end_date", { mode: "timestamp_ms" }),
    isMonthToMonth: integer("is_month_to_month", { mode: "boolean" }).notNull().default(false),
    moveInDate: integer("move_in_date", { mode: "timestamp_ms" }),
    moveOutDate: integer("move_out_date", { mode: "timestamp_ms" }),
    rentCents: integer("rent_cents").notNull(),
    // Held on behalf of the resident, not revenue. Kept on the lease and
    // mirrored into a trust-flagged GL account rather than mixed into
    // operating income — most states require the separation, and the ledger
    // categorizes deposits apart from rent for the same reason.
    depositCents: integer("deposit_cents").notNull().default(0),
    rentDueDay: integer("rent_due_day").notNull().default(1),
    // Points at the lease this one renewed, so renewal rate is counted from
    // records rather than inferred from dates lining up.
    renewalOfLeaseId: text("renewal_of_lease_id"),
    sourceProvider: text("source_provider").notNull().default("manual"),
    sourceConnectionId: text("source_connection_id").references(() => integrationConnections.id),
    externalId: text("external_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("leases_org_source_external_uq").on(table.organizationId, table.sourceProvider, table.externalId),
    index("leases_org_status_idx").on(table.organizationId, table.status),
    index("leases_org_end_idx").on(table.organizationId, table.endDate),
    index("leases_unit_idx").on(table.unitId),
  ],
);

// Many-to-many: a lease routinely has co-residents and guarantors, and
// collapsing them to a single "tenant name" column loses whoever else is
// actually liable for the balance.
export const leaseResidents = sqliteTable(
  "lease_residents",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    leaseId: text("lease_id").notNull().references(() => leases.id),
    residentId: text("resident_id").notNull().references(() => residents.id),
    role: text("role").notNull().default("primary"), // "primary" | "co_resident" | "guarantor"
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("lease_residents_lease_resident_uq").on(table.leaseId, table.residentId),
    index("lease_residents_org_idx").on(table.organizationId),
  ],
);

// The receivables spine: one row per charge, payment, credit or refund
// against a lease. Delinquency and AR aging are derived by walking these
// rows, never stored as a balance column — a stored balance drifts from its
// own history the first time a row is corrected, and then the number on
// screen has no way to be checked.
//
// `amountCents` is always POSITIVE; `entryType` carries the direction. A
// signed column invites a sign bug that silently turns a payment into a
// charge, and a negative number in a ledger export is ambiguous besides.
export const ledgerEntries = sqliteTable(
  "ledger_entries",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    leaseId: text("lease_id").notNull().references(() => leases.id),
    propertyId: text("property_id").notNull().references(() => properties.id), // denormalized for property-level AR without a join
    entryType: text("entry_type").notNull(), // LedgerEntryType: "charge" | "payment" | "credit" | "refund"
    category: text("category").notNull(), // LedgerCategory: "rent" | "deposit" | "late_fee" | "utility" | "other"
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    postedAt: integer("posted_at", { mode: "timestamp_ms" }).notNull(),
    // Charges only — the date aging is measured from. Null on payments, which
    // are not owed on a date.
    dueAt: integer("due_at", { mode: "timestamp_ms" }),
    memo: text("memo"),
    sourceProvider: text("source_provider").notNull().default("manual"),
    sourceConnectionId: text("source_connection_id").references(() => integrationConnections.id),
    externalId: text("external_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("ledger_entries_org_source_external_uq").on(table.organizationId, table.sourceProvider, table.externalId),
    index("ledger_entries_org_lease_idx").on(table.organizationId, table.leaseId),
    index("ledger_entries_org_posted_idx").on(table.organizationId, table.postedAt),
    index("ledger_entries_org_due_idx").on(table.organizationId, table.dueAt),
  ],
);

export const vendors = sqliteTable(
  "vendors",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    name: text("name").notNull(),
    trade: text("trade"), // free text: the trades a portfolio uses are not a closed set
    email: text("email"),
    phone: text("phone"),
    // Compliance, not trivia: an expired COI on an assigned vendor is a
    // liability an operator wants surfaced before the work is booked.
    insuranceExpiresAt: integer("insurance_expires_at", { mode: "timestamp_ms" }),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    sourceProvider: text("source_provider").notNull().default("manual"),
    sourceConnectionId: text("source_connection_id").references(() => integrationConnections.id),
    externalId: text("external_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("vendors_org_source_external_uq").on(table.organizationId, table.sourceProvider, table.externalId),
    index("vendors_org_active_idx").on(table.organizationId, table.isActive),
  ],
);

// One row per maintenance request. The four lifecycle timestamps are separate
// columns rather than a status-change log because every maintenance metric
// operators actually use is a difference between two of them — response time
// (reported→assigned), time to repair (reported→completed), and a vendor's
// own turnaround (assigned→completed). A status field alone can say a work
// order is closed but never how long it took.
export const workOrders = sqliteTable(
  "work_orders",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    propertyId: text("property_id").notNull().references(() => properties.id),
    unitId: text("unit_id").references(() => units.id), // null for common-area work
    leaseId: text("lease_id").references(() => leases.id), // who reported it, when a resident did
    category: text("category").notNull().default("general"), // WorkOrderCategory, lib/operations/types.ts
    priority: text("priority").notNull().default("routine"), // WorkOrderPriority — drives the SLA target
    status: text("status").notNull().default("reported"), // WorkOrderStatus
    summary: text("summary").notNull(),
    reportedAt: integer("reported_at", { mode: "timestamp_ms" }).notNull(),
    assignedAt: integer("assigned_at", { mode: "timestamp_ms" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    vendorId: text("vendor_id").references(() => vendors.id),
    estimateCents: integer("estimate_cents"),
    actualCostCents: integer("actual_cost_cents"),
    // Set when this work order is a return visit for work already done —
    // the raw material for first-time-fix rate, which the maintenance
    // research identifies as the single metric most tied to vendor cost.
    // Recorded explicitly rather than guessed from "same unit, same category,
    // within 30 days", which would count two genuinely different faults as a
    // callback.
    callbackOfWorkOrderId: text("callback_of_work_order_id"),
    sourceProvider: text("source_provider").notNull().default("manual"),
    sourceConnectionId: text("source_connection_id").references(() => integrationConnections.id),
    externalId: text("external_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("work_orders_org_source_external_uq").on(table.organizationId, table.sourceProvider, table.externalId),
    index("work_orders_org_status_idx").on(table.organizationId, table.status),
    index("work_orders_org_reported_idx").on(table.organizationId, table.reportedAt),
    index("work_orders_org_vendor_idx").on(table.organizationId, table.vendorId),
    index("work_orders_org_property_idx").on(table.organizationId, table.propertyId),
  ],
);

// Chart of accounts. Kept in the database rather than in code (unlike
// lib/billing/plans.ts) because it is the customer's chart, mirrored from
// their accounting system — every portfolio numbers and names it differently.
export const glAccounts = sqliteTable(
  "gl_accounts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    code: text("code").notNull(), // e.g. "4000", "6120"
    name: text("name").notNull(),
    accountType: text("account_type").notNull(), // GlAccountType, lib/operations/types.ts
    // Client money — deposits and owner funds — which most states require be
    // held separately from operating funds. Flagged here so a P&L rollup can
    // exclude it by construction instead of by remembering to.
    isTrustAccount: integer("is_trust_account", { mode: "boolean" }).notNull().default(false),
    sourceProvider: text("source_provider").notNull().default("manual"),
    sourceConnectionId: text("source_connection_id").references(() => integrationConnections.id),
    externalId: text("external_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("gl_accounts_org_code_uq").on(table.organizationId, table.code),
    index("gl_accounts_org_type_idx").on(table.organizationId, table.accountType),
  ],
);

// Posted amounts against a GL account, optionally attributed to a property.
//
// This is a REPORTING ledger, not a double-entry book of record: one row per
// posted amount, positive in the account's own natural direction (income rows
// are revenue, expense rows are spend). Aval reads books it does not keep —
// modeling debits and credits would imply this app could be the system of
// record for someone's accounting, which it is not and should not claim.
export const glTransactions = sqliteTable(
  "gl_transactions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    accountId: text("account_id").notNull().references(() => glAccounts.id),
    propertyId: text("property_id").references(() => properties.id), // null for portfolio-level or unallocated entries
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    postedAt: integer("posted_at", { mode: "timestamp_ms" }).notNull(),
    memo: text("memo"),
    sourceProvider: text("source_provider").notNull().default("manual"),
    sourceConnectionId: text("source_connection_id").references(() => integrationConnections.id),
    externalId: text("external_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("gl_transactions_org_source_external_uq").on(table.organizationId, table.sourceProvider, table.externalId),
    index("gl_transactions_org_posted_idx").on(table.organizationId, table.postedAt),
    index("gl_transactions_org_property_idx").on(table.organizationId, table.propertyId),
  ],
);

// One row per prospect, with a timestamp per stage reached.
//
// This is what `funnel_snapshots` cannot be. That table stores a count per
// stage per capture, which answers "how many applied last week" and nothing
// else. Stage timestamps on a record answer the questions operators actually
// act on: where the funnel drops off, how long each step takes, and which
// unit types sit longest — the leasing-velocity metrics the 2026 multifamily
// research puts at the top. Both tables stay: snapshots remain the cheap
// shape for a connector that only exposes aggregates.
export const leasingLeads = sqliteTable(
  "leasing_leads",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    propertyId: text("property_id").references(() => properties.id),
    unitId: text("unit_id").references(() => units.id),
    residentId: text("resident_id").references(() => residents.id), // set once a prospect becomes a person on a lease
    // Where the lead came from (ILS, website, referral, walk-in). Free text
    // rather than an enum: channel names differ per market and per connector,
    // and an unrecognized channel should still be counted, not dropped.
    channel: text("channel"),
    // The unit type asked for, as a label ("2BR/1BA"). Days-to-lease is only
    // actionable broken out this way — a portfolio-wide average hides that
    // studios move in a week and three-beds sit for two months.
    unitTypeLabel: text("unit_type_label"),
    stage: text("stage").notNull().default("inquiry"), // LeadStage, lib/operations/types.ts
    inquiredAt: integer("inquired_at", { mode: "timestamp_ms" }).notNull(),
    contactedAt: integer("contacted_at", { mode: "timestamp_ms" }),
    touredAt: integer("toured_at", { mode: "timestamp_ms" }),
    appliedAt: integer("applied_at", { mode: "timestamp_ms" }),
    approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
    signedAt: integer("signed_at", { mode: "timestamp_ms" }),
    lostAt: integer("lost_at", { mode: "timestamp_ms" }),
    lostReason: text("lost_reason"),
    sourceProvider: text("source_provider").notNull().default("manual"),
    sourceConnectionId: text("source_connection_id").references(() => integrationConnections.id),
    externalId: text("external_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("leasing_leads_org_source_external_uq").on(table.organizationId, table.sourceProvider, table.externalId),
    index("leasing_leads_org_stage_idx").on(table.organizationId, table.stage),
    index("leasing_leads_org_inquired_idx").on(table.organizationId, table.inquiredAt),
  ],
);

// Two connected systems describing the same thing differently.
//
// The premise of connecting a portfolio's whole stack is that the pieces
// disagree — a PMS and an accounting system will not report the same rent for
// the same unit forever. The tempting behavior is last-write-wins, which
// produces a dashboard that is confidently wrong and gives a user no way to
// notice. So a differing value from a different source is written HERE and the
// stored row is left alone; the operator decides, and until they do, readers
// can see the field is contested.
//
// Holds values as text (`valueA`/`valueB`) because it spans every field type
// in the operations model, and it is a record of what each system said rather
// than something arithmetic is done on.
export const operationsConflicts = sqliteTable(
  "operations_conflicts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    entityType: text("entity_type").notNull(), // ConflictEntityType, lib/operations/types.ts
    entityId: text("entity_id").notNull(),
    field: text("field").notNull(),
    valueA: text("value_a").notNull(),
    sourceA: text("source_a").notNull(),
    valueB: text("value_b").notNull(),
    sourceB: text("source_b").notNull(),
    status: text("status").notNull().default("open"), // "open" | "resolved"
    resolution: text("resolution"), // "kept_a" | "kept_b" | "dismissed"
    detectedAt: integer("detected_at", { mode: "timestamp_ms" }).notNull(),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    // One open conflict per contested field, not one per sync run: a nightly
    // sync would otherwise pile up an identical row every night until someone
    // resolved it, burying the other findings.
    uniqueIndex("operations_conflicts_entity_field_uq").on(table.organizationId, table.entityType, table.entityId, table.field),
    index("operations_conflicts_org_status_idx").on(table.organizationId, table.status),
  ],
);

/* ══ Agent runtime: durable task execution ══════════════════════════════════
 *
 * Before these tables, an agent run lived entirely in one HTTP request's
 * memory (lib/ask-aval/loop.ts): a worker restart mid-analysis lost the run
 * with no record it had started. These three tables are the durable half —
 * the task, its steps, and the approvals a step is waiting on.
 *
 * Storage discipline matches answer_audit_log: **digests, not payloads.** A
 * tool result can hold resident names and balances; a step table full of
 * those would be a second copy of the most sensitive data in the system,
 * retained for bookkeeping. Steps store a SHA-256 of the arguments and the
 * result plus non-identifying facts, which is enough to prove what happened
 * and to detect a replay, without the log becoming a liability of its own.
 */

// One agent run. `status` is the state machine from §13 of the production
// readiness guide; `leaseOwner`/`leaseExpiresAt` are the distributed lock that
// stops two workers executing the same task (§14).
export const agentTasks = sqliteTable(
  "agent_tasks",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    // The user whose authority the run carries. Every policy check re-reads
    // this rather than trusting anything in the task's own message history.
    userId: text("user_id").notNull(),
    // Persona id — a built-in role or a custom persona row. Resolved to a
    // permission envelope by lib/agents/permissions.ts on every step.
    agentId: text("agent_id").notNull(),
    /**
     * The employee that owns this work.
     *
     * Durable, so a restart resumes with the same owner rather than re-deriving
     * one. Nullable while the built-in specialists are still addressed by
     * `agentId`; once every persona resolves to an employee record this becomes
     * the only answer to "who is doing this".
     */
    employeeId: text("employee_id"),
    goal: text("goal").notNull(),
    // QUEUED | RUNNING | WAITING_FOR_TOOL | WAITING_FOR_APPROVAL | COMPLETED | FAILED | CANCELLED
    status: text("status").notNull(),
    // Conversation state, so a resumed run continues rather than restarting.
    // Sized by maxSteps and the model's own max_tokens, not unbounded.
    executionScopeJson: text("execution_scope_json").notNull().default("{}"),
    checkJson: text("check_json").notNull().default("{}"),
    deadlineAt: integer("deadline_at", { mode: "timestamp_ms" }),
    transcriptJson: text("transcript_json").notNull().default("[]"),
    stepCount: integer("step_count").notNull().default(0),
    maxSteps: integer("max_steps").notNull(),
    tokensUsed: integer("tokens_used").notNull().default(0),
    maxTokens: integer("max_tokens").notNull(),
    // Task-level retry bookkeeping. A model/provider outage is retried by a
    // later worker invocation with exponential backoff; it is not converted
    // immediately into a terminal failure and it is never retried in-memory.
    executionAttempts: integer("execution_attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
    // Delegation lineage (§19). Depth is capped in lib/agents/policy.ts.
    parentTaskId: text("parent_task_id"),
    delegationDepth: integer("delegation_depth").notNull().default(0),
    // Cooperative cancellation: set by a request, observed by the worker at
    // the top of each step. A running step is never killed mid-flight, so a
    // cancelled task can never leave a half-executed mutating tool behind.
    cancelRequested: integer("cancel_requested", { mode: "boolean" }).notNull().default(false),
    // Worker lease. A task is claimable when its lease is absent or expired,
    // which is what makes crash recovery automatic: a dead worker's lease
    // simply times out and the next worker picks the task up mid-run.
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    lastHeartbeatAt: integer("last_heartbeat_at", { mode: "timestamp_ms" }),
    // Terminal outcome. `resultJson` is the rendered answer, the one payload
    // worth retaining because the user asked for it; `error` is a message,
    // never a stack trace or a provider response body.
    resultJson: text("result_json"),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("agent_tasks_org_created_idx").on(table.organizationId, table.createdAt),
    // The claim query: find runnable work whose lease has expired.
    index("agent_tasks_status_lease_idx").on(table.status, table.leaseExpiresAt),
    index("agent_tasks_status_attempt_idx").on(table.status, table.nextAttemptAt),
    index("agent_tasks_parent_idx").on(table.parentTaskId),
  ],
);

// One row per executed step, appended as the run proceeds — this is what makes
// a run resumable and what the execution-trace UI reads.
export const agentTaskSteps = sqliteTable(
  "agent_task_steps",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull().references(() => agentTasks.id),
    organizationId: text("organization_id").notNull(),
    // Position of this row in the task's trace. Unique with taskId, so the
    // trace has one definite order and a racing writer loses loudly instead of
    // interleaving. Assigned by appendStep under the task's lease.
    sequence: integer("sequence").notNull(),
    // Which reasoning step this row belongs to. Deliberately NOT unique: one
    // step is a model call plus every tool call it proposed, so a step maps to
    // several rows. Duplicate *execution* is prevented by idempotencyKey
    // below, which is the guarantee that actually matters.
    stepIndex: integer("step_index").notNull(),
    // model_call | tool_call | policy_deny | approval_requested | approval_decided | delegation | error | completion
    kind: text("kind").notNull(),
    // The concrete route used for a model_call. Explicit history matters when
    // an org changes providers after a task has already run.
    modelProvider: text("model_provider"),
    modelName: text("model_name"),
    toolName: text("tool_name"),
    // allow | deny | require_approval — the policy engine's verdict, recorded
    // whether or not the tool then ran.
    policyEffect: text("policy_effect"),
    denyCode: text("deny_code"),
    riskLevel: text("risk_level"),
    // SHA-256 of the arguments and of the result. Never the values themselves.
    argsDigest: text("args_digest"),
    resultDigest: text("result_digest"),
    // Which attempt this was, so a retry is visible as a retry rather than as
    // two independent calls.
    attempt: integer("attempt").notNull().default(1),
    durationMs: integer("duration_ms"),
    // Present only for mutating tools. Unique across the table: a second
    // insert with the same key is rejected by the database, which is what
    // makes duplicate execution impossible rather than merely unlikely.
    idempotencyKey: text("idempotency_key"),
    /**
     * Where an external effect landed, recorded after the provider accepted it.
     * Verification needs to re-read the exact record the write created, and the
     * reservation is written before the provider call, so these are filled in
     * afterwards against the same idempotency key.
     */
    sourceProvider: text("source_provider"),
    externalRecordId: text("external_record_id"),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("agent_task_steps_task_sequence_uq").on(table.taskId, table.sequence),
    // Nullable and unique: SQLite lets NULLs coexist, so read-only steps are
    // unconstrained while any two mutating steps sharing a key collide. This
    // index *is* the duplicate-prevention mechanism — a retried worker that
    // recomputes the same key cannot insert a second row, so the second
    // execution never happens rather than merely being unlikely.
    uniqueIndex("agent_task_steps_idempotency_uq").on(table.idempotencyKey),
    index("agent_task_steps_task_idx").on(table.taskId, table.stepIndex),
  ],
);

// A proposed action parked in WAITING_FOR_APPROVAL. The agent prepares it; a
// person decides. Rows are never deleted — a rejection is as much a record as
// an approval, and §15 wants both.
export const agentApprovals = sqliteTable(
  "agent_approvals",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull().references(() => agentTasks.id),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    stepIndex: integer("step_index").notNull(),
    toolName: text("tool_name").notNull(),
    riskLevel: text("risk_level").notNull(),
    // automatic | single_approver | elevated_approver | refused (lib/agents/financial.ts)
    tier: text("tier").notNull(),
    amountCents: integer("amount_cents"),
    currency: text("currency"),
    // What the approver is shown: the action, its arguments in a redacted
    // summary form, and the evidence the agent assembled. Retained because a
    // person has to be able to see what they approved, later.
    evidenceJson: text("evidence_json").notNull().default("{}"),
    // pending | approved | rejected | expired
    status: text("status").notNull(),
    requestedAt: integer("requested_at", { mode: "timestamp_ms" }).notNull(),
    // Approvals go stale: an amount that was right this morning may not be
    // tonight, so an undecided request expires rather than waiting forever.
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
    decidedByUserId: text("decided_by_user_id"),
    decisionNote: text("decision_note"),
    // Elevated financial actions need two distinct approvers. Decisions are
    // append-only rows below; these counters are only the query-friendly
    // projection used to decide whether the parked task may resume.
    requiredApprovals: integer("required_approvals").notNull().default(1),
    approvalsReceived: integer("approvals_received").notNull().default(0),
    policyVersion: integer("policy_version").notNull().default(1),
  },
  (table) => [
    index("agent_approvals_org_status_idx").on(table.organizationId, table.status),
    uniqueIndex("agent_approvals_task_step_uq").on(table.taskId, table.stepIndex),
  ],
);

// One immutable row per human decision. A unique (approval, user) pair means
// two clicks by the same person can never satisfy a two-person gate.
export const agentApprovalDecisions = sqliteTable(
  "agent_approval_decisions",
  {
    id: text("id").primaryKey(),
    approvalId: text("approval_id").notNull().references(() => agentApprovals.id),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    userId: text("user_id").notNull(),
    decision: text("decision").notNull(), // approved | rejected
    note: text("note"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("agent_approval_decisions_approval_user_uq").on(table.approvalId, table.userId),
    index("agent_approval_decisions_org_created_idx").on(table.organizationId, table.createdAt),
  ],
);

// A financial policy is unusable until the workspace owner explicitly
// approves it. Automatic payment authority is intentionally absent: every
// money-moving action always requires at least one human decision.
export const agentExecutionPolicies = sqliteTable("agent_execution_policies", {
  organizationId: text("organization_id").primaryKey().references(() => organizations.id),
  status: text("status").notNull().default("draft"), // draft | approved | suspended
  singleApprovalMaxCents: integer("single_approval_max_cents").notNull().default(50_000),
  hardCeilingCents: integer("hard_ceiling_cents").notNull().default(2_500_000),
  dailyLimitCents: integer("daily_limit_cents").notNull().default(5_000_000),
  allowedCurrenciesJson: text("allowed_currencies_json").notNull().default('["USD"]'),
  // SHA-256 fingerprints only. Account identifiers remain in the provider;
  // Aval can check an allowlist without becoming another copy of bank data.
  allowedAccountFingerprintsJson: text("allowed_account_fingerprints_json").notNull().default("[]"),
  version: integer("version").notNull().default(1),
  approvedByUserId: text("approved_by_user_id"),
  approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// Mutable reconciliation projection for each financial side effect. The
// adjacent event table is the immutable record; this row makes due-work and
// discrepancy queries bounded and indexable.
export const agentFinancialOperations = sqliteTable(
  "agent_financial_operations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    taskId: text("task_id").notNull().references(() => agentTasks.id),
    approvalId: text("approval_id").references(() => agentApprovals.id),
    stepIndex: integer("step_index").notNull(),
    toolName: text("tool_name").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    accountFingerprint: text("account_fingerprint").notNull(),
    status: text("status").notNull(), // reserved | submitted | settled | failed | unknown | reversed
    reconciliationStatus: text("reconciliation_status").notNull().default("pending"),
    externalTransactionId: text("external_transaction_id"),
    resultDigest: text("result_digest"),
    discrepancyCode: text("discrepancy_code"),
    reconcileAttempts: integer("reconcile_attempts").notNull().default(0),
    nextReconcileAt: integer("next_reconcile_at", { mode: "timestamp_ms" }).notNull(),
    lastReconciledAt: integer("last_reconciled_at", { mode: "timestamp_ms" }),
    // Separate from the task lease: provider read-backs can overlap a task's
    // own worker, and two cron invocations must never reconcile one operation
    // concurrently. Expiry makes a dead reconciler recoverable.
    reconcileLeaseOwner: text("reconcile_lease_owner"),
    reconcileLeaseExpiresAt: integer("reconcile_lease_expires_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    settledAt: integer("settled_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("agent_financial_operations_idempotency_uq").on(table.idempotencyKey),
    uniqueIndex("agent_financial_operations_external_uq").on(table.toolName, table.externalTransactionId),
    index("agent_financial_operations_reconcile_idx").on(table.reconciliationStatus, table.nextReconcileAt, table.reconcileLeaseExpiresAt),
    index("agent_financial_operations_org_created_idx").on(table.organizationId, table.createdAt),
  ],
);

export const agentFinancialEvents = sqliteTable(
  "agent_financial_events",
  {
    id: text("id").primaryKey(),
    operationId: text("operation_id").notNull().references(() => agentFinancialOperations.id),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    sequence: integer("sequence").notNull(),
    kind: text("kind").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    externalTransactionId: text("external_transaction_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("agent_financial_events_operation_sequence_uq").on(table.operationId, table.sequence),
    index("agent_financial_events_org_created_idx").on(table.organizationId, table.createdAt),
  ],
);

// Persistent worker telemetry backs the health endpoint and survives log
// retention. It contains counts and timings only, never goals or tool data.
export const agentWorkerRuns = sqliteTable(
  "agent_worker_runs",
  {
    id: text("id").primaryKey(),
    trigger: text("trigger").notNull(), // scheduled | request | approval | manual
    status: text("status").notNull(), // running | completed | failed
    tasksScanned: integer("tasks_scanned").notNull().default(0),
    tasksAdvanced: integer("tasks_advanced").notNull().default(0),
    tasksCompleted: integer("tasks_completed").notNull().default(0),
    tasksFailed: integer("tasks_failed").notNull().default(0),
    tasksParked: integer("tasks_parked").notNull().default(0),
    errorDigest: text("error_digest"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("agent_worker_runs_started_idx").on(table.startedAt)],
);

// Native workspace planning. Dates are UTC instants; UI uses the viewer's time zone.
export const planningProjects = sqliteTable("planning_projects", {
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull().references(()=>organizations.id),
  title: text("title").notNull(), description: text("description").notNull().default(""), color: text("color").notNull().default("blue"), createdAt: integer("created_at").notNull(),
}, (t)=>[index("planning_projects_org_idx").on(t.organizationId)]);
export const planningItems = sqliteTable("planning_items", {
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull().references(()=>organizations.id),
  title: text("title").notNull(), description: text("description").notNull().default(""), kind: text("kind").notNull().default("task"), status: text("status").notNull().default("planned"),
  projectId: text("project_id").references(()=>planningProjects.id), assigneeId: text("assignee_id"), startsAt: integer("starts_at").notNull(), endsAt: integer("ends_at").notNull(),
  version: integer("version").notNull().default(1), createdBy: text("created_by").notNull(), updatedAt: integer("updated_at").notNull(),
}, (t)=>[index("planning_items_org_date_idx").on(t.organizationId,t.startsAt)]);

// One record per authenticated active minute; uniqueness prevents double counting across tabs.
export const workspaceUsage = sqliteTable("workspace_usage", {
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull().references(() => organizations.id),
  userId: text("user_id").notNull(), minute: integer("minute").notNull(),
}, t => [uniqueIndex("workspace_usage_subject_minute").on(t.organizationId, t.userId, t.minute)]);

/** Durable provider operations: reserve before sending; uncertain outcomes are never blindly retried. */
export const communicationDeliveries = sqliteTable("communication_deliveries", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  connectionId: text("connection_id").notNull().references(() => integrationConnections.id),
  requestKey: text("request_key").notNull(),
  payloadDigest: text("payload_digest").notNull(),
  kind: text("kind").notNull(),
  destination: text("destination").notNull(),
  body: text("body").notNull(),
  status: text("status").notNull().default("sending"),
  providerId: text("provider_id"),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (t) => [uniqueIndex("communication_deliveries_org_request_uq").on(t.organizationId, t.requestKey), index("communication_deliveries_org_created_idx").on(t.organizationId, t.createdAt)]);

export const communicationSettings = sqliteTable("communication_settings", {
  organizationId: text("organization_id").primaryKey().references(() => organizations.id),
  configJson: text("config_json").notNull().default("{}"),
  updatedBy: text("updated_by").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const communicationPollSources = sqliteTable('communication_poll_sources', {
 id: text('id').primaryKey(),
 organizationId: text('organization_id').notNull().references(()=>organizations.id),
 provider: text('provider').notNull(),
 resourceId: text('resource_id').notNull().default(''),
 enabled: integer('enabled',{mode:'boolean'}).notNull().default(true),
 lastAttemptAt: integer('last_attempt_at',{mode:'timestamp_ms'}),
 lastSuccessAt: integer('last_success_at',{mode:'timestamp_ms'}),
 error: text('error'),
}, t=>[uniqueIndex('communication_poll_source_uq').on(t.organizationId,t.provider,t.resourceId),index('communication_poll_due_idx').on(t.enabled,t.lastAttemptAt)]);


export const agentChecks = sqliteTable("agent_checks", {
 id:text("id").primaryKey(), organizationId:text("organization_id").notNull().references(()=>organizations.id), taskId:text("task_id").notNull().references(()=>agentTasks.id), stepIndex:integer("step_index").notNull(), exitCode:integer("exit_code").notNull(), outputJson:text("output_json").notNull(), createdAt:integer("created_at",{mode:"timestamp_ms"}).notNull(),
},t=>[index("agent_checks_task_idx").on(t.organizationId,t.taskId)]);
export const agentMemory = sqliteTable("agent_memory", {
 id:text("id").primaryKey(),organizationId:text("organization_id").notNull().references(()=>organizations.id),taskId:text("task_id").notNull().references(()=>agentTasks.id),stepIndex:integer("step_index").notNull(),requestKey:text("request_key").notNull(),body:text("body").notNull(),createdAt:integer("created_at",{mode:"timestamp_ms"}).notNull(),
},t=>[uniqueIndex("agent_memory_request_uq").on(t.organizationId,t.requestKey),index("agent_memory_task_step_idx").on(t.taskId,t.stepIndex)]);
export const agentPlanNodes = sqliteTable("agent_plan_nodes", {
 id:text("id").primaryKey(),organizationId:text("organization_id").notNull().references(()=>organizations.id),rootTaskId:text("root_task_id").notNull().references(()=>agentTasks.id),revision:integer("revision").notNull(),nodeKey:text("node_key").notNull(),taskId:text("task_id").notNull().references(()=>agentTasks.id),dependenciesJson:text("dependencies_json").notNull(),createdAt:integer("created_at",{mode:"timestamp_ms"}).notNull(),
},t=>[uniqueIndex("agent_plan_node_uq").on(t.rootTaskId,t.revision,t.nodeKey),index("agent_plan_root_idx").on(t.rootTaskId,t.revision)]);

export const agentModelContexts = sqliteTable("agent_model_contexts", {
 id:text("id").primaryKey(),organizationId:text("organization_id").notNull().references(()=>organizations.id),taskId:text("task_id").notNull().references(()=>agentTasks.id),stepIndex:integer("step_index").notNull(),contextJson:text("context_json").notNull(),digest:text("digest").notNull(),createdAt:integer("created_at",{mode:"timestamp_ms"}).notNull(),
},t=>[index("agent_model_context_task_idx").on(t.organizationId,t.taskId,t.stepIndex)]);

/**
 * Per-org authorization for a PMS write action (docs/PMS_INTEGRATION.md, P0/P2).
 *
 * Deliberately shaped like `agent_execution_policies` and deliberately NOT like
 * `communication_settings`. A `signed_authorization` that cannot say who signed
 * it and when is not an authorization, it is a checkbox — and for the actions
 * gated here (money in a trust account, a message to a housing applicant) the
 * identity of the approver is the entire control.
 *
 * One row per (org, provider, action). Absence means not enabled: the resolver
 * reads a missing row as `off`, never as permitted. `status` exists because an
 * authorization is revocable without being deleted — `suspended` preserves the
 * audit trail of who had once signed for it.
 */
export const pmsWriteAuthorizations = sqliteTable(
  "pms_write_authorizations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    provider: text("provider").notNull(),
    // A PmsAction from lib/pms/types.ts. Stored as text because the enum lives
    // in code, where a test can assert every stored value still resolves.
    action: text("action").notNull(),
    status: text("status").notNull().default("draft"), // draft | approved | suspended
    // True only when a human countersigned the provider's terms override. The
    // resolver requires this for any action whose descriptor says permitted:false.
    signedAuthorization: integer("signed_authorization", { mode: "boolean" }).notNull().default(false),
    // Free text naming the document or counsel sign-off. Not parsed; it exists
    // so an auditor can find the paper.
    authorizationReference: text("authorization_reference"),
    version: integer("version").notNull().default(1),
    approvedByUserId: text("approved_by_user_id"),
    approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("pms_write_auth_uq").on(table.organizationId, table.provider, table.action),
    index("pms_write_auth_org_idx").on(table.organizationId, table.status),
  ],
);

/**
 * A recorded, replayable path for one (provider, action) — the cache behind the
 * `unlearned` state.
 *
 * The first time an action is needed on a provider whose mechanism is `ui`, the
 * agent reads the page's semantic tree, works out the path, and proposes it on
 * an approval card. On approval it executes *and* stores the path here. Every
 * later run replays this row: no model call, deterministic, and renderable on an
 * approval card before it runs, which a live vision agent can never be.
 *
 * `version` is part of the key rather than a mutable column because a provider
 * UI redesign does not invalidate history — it creates a new flow. Keeping the
 * old row lets an audit entry from last month still resolve to the steps that
 * actually ran.
 *
 * `provider` is scoped per-org rather than global on purpose: two AppFolio
 * tenants can have different field layouts, and a flow learned in one workspace
 * is not evidence about another. Global promotion is a later decision, and it
 * needs to be a deliberate one.
 */
export const pmsActionFlows = sqliteTable(
  "pms_action_flows",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    provider: text("provider").notNull(),
    action: text("action").notNull(),
    version: integer("version").notNull().default(1),
    // Ordered, declarative steps — selectors and values, no executable code.
    // Reviewed on an approval card, so it has to be readable by a person.
    stepsJson: text("steps_json").notNull(),
    // SHA-256 of stepsJson. An approval binds to this, so a flow edited after
    // approval fails to replay rather than running something unapproved.
    digest: text("digest").notNull(),
    status: text("status").notNull().default("candidate"), // candidate | active | retired
    learnedByUserId: text("learned_by_user_id"),
    lastReplayAt: integer("last_replay_at", { mode: "timestamp_ms" }),
    lastReplayOk: integer("last_replay_ok", { mode: "boolean" }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("pms_action_flow_uq").on(table.organizationId, table.provider, table.action, table.version),
    index("pms_action_flow_lookup_idx").on(table.organizationId, table.provider, table.action, table.status),
  ],
);

/**
 * Pending PMS writes awaiting the desktop runner.
 *
 * No new queue infrastructure: this follows the `integration_events` pattern the
 * WhatsApp discovery identified as the one that works on D1 — an append-only log
 * with primary-key dedupe, drained by a poller. The difference is who drains it.
 * `integration_events` is drained by the one-minute cron; this is drained by the
 * Electron runner asking for its own org's pending rows, because the whole point
 * of `runner: 'desktop'` is that the cron cannot do this work.
 *
 * `leaseId`-style provider ids are NOT stored here; `payloadJson` holds only what
 * the approved flow needs, and the approval it binds to is the record of intent.
 */
export const pmsWriteQueue = sqliteTable(
  "pms_write_queue",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    provider: text("provider").notNull(),
    action: text("action").notNull(),
    // The approval that authorized this write. Null is only valid for actions
    // whose resolution did not require one; the drainer re-checks either way.
    approvalId: text("approval_id"),
    flowId: text("flow_id"),
    payloadJson: text("payload_json").notNull(),
    // Caller-supplied idempotency key. Unique per org so a retried enqueue
    // collides on the index instead of queueing a second write.
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("pending"), // pending | leased | done | failed | abandoned
    // Set while a runner holds it, so two desktop instances for one org cannot
    // both execute. Expires, because a laptop closing mid-write is normal.
    leasedBy: text("leased_by"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("pms_write_queue_idem_uq").on(table.organizationId, table.idempotencyKey),
    index("pms_write_queue_drain_idx").on(table.organizationId, table.status, table.createdAt),
  ],
);

/**
 * Which system an agent works inside (docs/PMS_INTEGRATION_DISCOVERY.md).
 *
 * `agent_personas` says what an agent *is* and which tools it may frame; nothing
 * said which PMS it works in. Without that, `pmsToolAvailability()` had to
 * resolve across every connected provider and let the model name one as a tool
 * argument — so an org with two PMSs offered every agent both.
 *
 * A join row, not a `provider` column on `agent_personas`, because one persona
 * should be deployable into several PMSs at different autonomy levels and one
 * PMS should host several personas. A column forces one-to-one and makes "the
 * maintenance agent in AppFolio is supervised while the one in DoorLoop is
 * autonomous" unrepresentable.
 *
 * `personaId` carries no foreign key on purpose: it holds either an
 * `agent_personas.id` or a built-in PersonaId that has no row to point at.
 */
export const agentDeployments = sqliteTable(
  "agent_deployments",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    // An agent_personas.id, or a built-in PersonaId. No FK — see above.
    personaId: text("persona_id").notNull(),
    // The PMS this deployment works inside. Matches integration_connections.provider.
    provider: text("provider").notNull(),
    // JSON string array of PmsWorkflow this deployment owns here. A deployment
    // that owns "maintenance" does not thereby own "arrears" in the same system.
    workflowsJson: text("workflows_json").notNull().default("[]"),
    autonomyMode: text("autonomy_mode").notNull().default("supervised"), // supervised | assisted | autonomous
    status: text("status").notNull().default("active"), // active | paused
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("agent_deployments_uq").on(table.organizationId, table.personaId, table.provider),
    index("agent_deployments_lookup_idx").on(table.organizationId, table.personaId, table.status),
  ],
);

/**
 * Every seat slug ever issued, and who it belongs to. Permanently.
 *
 * `slug` is the primary key and rows are **never deleted**, which is the whole
 * design: a slug cannot be reissued, so mail a PMS is still sending to a
 * workspace's old address can never arrive at a different workspace. That is not
 * a hypothetical — a seat address lives inside a customer's PMS configuration,
 * outside our control, and may be used for years after they stopped thinking
 * about it.
 *
 * A workspace that renames gains a row. It never gives one up, and every row it
 * holds keeps resolving to it. `organizations.seatSlug` names which of them is
 * the current one to display; this table decides which mail is whose.
 */
export const organizationSeatSlugs = sqliteTable(
  "organization_seat_slugs",
  {
    slug: text("slug").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    /** Who claimed it, for the audit trail on an address a customer will type. */
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("organization_seat_slugs_org_idx").on(table.organizationId)],
);

/**
 * Who may write to a workspace's seat address.
 *
 * `verifySender` (lib/pms/inbound/authentication.ts) refuses every message when
 * this table has no row for the workspace, and that is the intended reading: a
 * workspace that has not said who may write to its seat has not consented. Same
 * rule as `pms_write_authorizations` — absence is never permission.
 *
 * A row is (workspace, domain, provider). The provider is not decoration: it is
 * how the read envelope knows which system's format a verified message is in,
 * without inferring it from content an attacker could shape. Mail that
 * authenticates as `mail.appfolio.com` is parsed as AppFolio because an operator
 * said that domain is their AppFolio, not because the body looked like it.
 *
 * Domains are stored as the operator confirmed them, and matched by
 * `domainMatches`, which accepts subdomains. So a row for `appfolio.com` covers
 * `mail.appfolio.com` without an operator having to predict which subdomains
 * their PMS will send from next year.
 *
 * Unlike `organization_seat_slugs`, rows here are deletable. Revoking a sender
 * has to be possible and immediate — the address is permanent precisely so that
 * consent does not have to be.
 */
export const pmsSeatSenders = sqliteTable(
  "pms_seat_senders",
  {
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    /** Normalized by `sender-domain.ts` before it gets here: lowercase, no scheme, no leading dot. */
    domain: text("domain").notNull(),
    /** A provider id from lib/pms/providers. Verified mail from this domain is read as this system. */
    providerId: text("provider_id").notNull(),
    /** Who allowed it. This is a consent record, so the approver is part of it. */
    addedBy: text("added_by").notNull(),
    addedAt: integer("added_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("pms_seat_senders_uq").on(table.organizationId, table.domain),
    index("pms_seat_senders_org_idx").on(table.organizationId),
  ],
);

/**
 * One row per message the seat has processed — the reader's ledger.
 *
 * Written by `aval-pms-seat-reader` (worker/pms-seat-reader.ts), which is the
 * only component holding both the unverified inbox and the database. The app
 * never reads R2; it reads this. That split is deliberate and is the reason this
 * table exists at all rather than the review surface listing the bucket:
 * `d9210f8` took the inbox binding off the app Worker, and re-adding it to draw
 * a settings panel would undo the boundary both wrangler configs exist to hold.
 *
 * `digest` is the primary key and is the message's own content hash, so a sweep
 * that runs twice, or a PMS that sends the same notice twice, writes the same
 * row. The sweep is therefore safe to re-run at any point, including mid-failure.
 *
 * ## What may be rendered from this table
 *
 * `authenticated_domain` is null unless the domain was actually authenticated by
 * the topmost trusted `Authentication-Results`. That is a storage-level control,
 * not a convention: a held message's `From` is chosen by whoever sent it, and a
 * review surface that rendered a claimed domain would be putting attacker-picked
 * text on an operator's screen next to an "Allow" button. Mail that authenticated
 * nothing is counted, never named.
 *
 * `reason` and `observed_authserv_ids` are triage fields. They can contain
 * sender-influenced text and are for a developer reading a query result, never
 * for a customer-facing surface.
 */
export const pmsSeatMessages = sqliteTable(
  "pms_seat_messages",
  {
    /**
     * `<recipient>:<digest>` — a key Aval constructs, not one taken from the mail.
     *
     * The digest alone cannot be the key. It is a content hash, and two
     * workspaces can be sent the *same bytes* — one vendor notice addressed to
     * both, or the same announcement to two seats. Keyed on the digest, the
     * second workspace's row would overwrite the first, taking its
     * organization_id with it: one customer's held mail silently reattributed
     * to another. The recipient is in the key for that reason, and it works
     * because a seat address belongs to one workspace forever
     * (`organization_seat_slugs`).
     */
    id: text("id").primaryKey(),
    /** SHA-256 of the raw message, and the last segment of its R2 key. */
    digest: text("digest").notNull(),
    /** The seat address it was sent to. Ours, not the sender's, so safe to display. */
    recipient: text("recipient").notNull(),
    /** Null when the slug belongs to no workspace — mail to an address never issued. */
    organizationId: text("organization_id"),
    /** verified | held | unauthenticated | unassigned — see lib/pms/inbound/disposition.ts. */
    disposition: text("disposition").notNull(),
    /** Set only when authentication established it. Null is the signal not to name a sender. */
    authenticatedDomain: text("authenticated_domain"),
    /** dmarc | dkim, whichever established the domain. */
    method: text("method"),
    /** The provider from the matching allowlist row, so the parser is chosen by consent. */
    providerId: text("provider_id"),
    /** Triage only. May contain sender-influenced text; never render to an operator. */
    reason: text("reason"),
    /**
     * The authserv-ids actually seen on the message, recorded because the one
     * Cloudflare uses is not documented anywhere we could find. If verification
     * fails across the board, this column is the difference between a one-query
     * answer and a blind hunt. Triage only — a sender can put ids here too.
     */
    observedAuthservIds: text("observed_authserv_ids"),
    /** Where the object now lives, so a later sweep or an audit can fetch it. */
    objectKey: text("object_key").notNull(),
    receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
    processedAt: integer("processed_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("pms_seat_messages_org_idx").on(table.organizationId, table.disposition),
    index("pms_seat_messages_held_idx").on(table.organizationId, table.authenticatedDomain),
    index("pms_seat_messages_digest_idx").on(table.digest),
  ],
);

/**
 * One observed fact about one operational entity, with where it came from and
 * how far to trust it.
 *
 * The operational tables (`properties`, `residents`, `workOrders`,
 * `ledgerEntries`) already record `sourceProvider`, `sourceConnectionId` and
 * `externalId`, which answers "which system did this row come from". They do
 * not answer the questions an agent has to ask before acting: when did the
 * provider consider this true, when did we last look, is it still fresh, is it
 * authoritative or something a model inferred, and does another system
 * disagree.
 *
 * A fact is never overwritten by a different source. A second source writes a
 * second row, and the two are marked `conflicted` — `operations_conflicts`
 * remains the surface a person resolves them on. Collapsing them would be the
 * silent overwrite the design exists to prevent.
 */
export const operationalFacts = sqliteTable(
  "operational_facts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    /** property | unit | resident | lease | work_order | vendor | account */
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    /** The field or claim this fact is about, as a stable path: `balance_cents`, `status`, `lease.end_date`. */
    factType: text("fact_type").notNull(),
    /** Scalar rendering, for the common case where the value fits in one column. */
    value: text("value"),
    /** Pointer for a value too large or too structured to inline. Exactly one of `value`/`valueRef` is set. */
    valueRef: text("value_ref"),
    /** provider | aval_native | human | document | inference */
    sourceType: text("source_type").notNull(),
    sourceProvider: text("source_provider"),
    sourceRecordId: text("source_record_id"),
    /** When the source considered this true. Null when the provider offers no effective time — an honest null, never a fabricated one. */
    observedAt: integer("observed_at", { mode: "timestamp_ms" }),
    /** When Aval last read it. Always known, because Aval did the reading. */
    syncedAt: integer("synced_at", { mode: "timestamp_ms" }).notNull(),
    /** Freshness horizon. Staleness is `now() > expiresAt`, derived rather than stored, so it cannot itself go stale. */
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    /** Named policy the horizon came from, so a change of policy is legible. */
    freshnessPolicy: text("freshness_policy"),
    /** authoritative | reported | inferred | human_confirmed */
    authoritativeness: text("authoritativeness").notNull(),
    /** Only meaningful for `inference`; null elsewhere rather than a misleading 1.0. */
    confidence: real("confidence"),
    /** Evidence or fact ids this was derived from, as JSON. */
    derivedFromJson: text("derived_from_json").notNull().default("[]"),
    /** none | conflicted | superseded */
    conflictState: text("conflict_state").notNull().default("none"),
    /** The fact that replaced this one, when superseded. */
    supersededBy: text("superseded_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("operational_facts_entity_idx").on(table.organizationId, table.entityType, table.entityId, table.factType),
    index("operational_facts_conflict_idx").on(table.organizationId, table.conflictState),
    // One live fact per (entity, field, source). A re-sync from the same source
    // updates its own row; a different source gets its own, which is what makes
    // a disagreement visible instead of destructive.
    uniqueIndex("operational_facts_source_uq").on(
      table.organizationId, table.entityType, table.entityId, table.factType, table.sourceType, table.sourceProvider,
    ),
    check("operational_facts_source_type", sql`source_type IN ('provider','aval_native','human','document','inference')`),
    check("operational_facts_authority", sql`authoritativeness IN ('authoritative','reported','inferred','human_confirmed')`),
    check("operational_facts_conflict_state", sql`conflict_state IN ('none','conflicted','superseded')`),
    check("operational_facts_confidence_range", sql`confidence IS NULL OR (confidence >= 0 AND confidence <= 1)`),
    // An inference must say how sure it is; anything else must not pretend to.
    check("operational_facts_confidence_scope", sql`(source_type = 'inference') = (confidence IS NOT NULL)`),
  ],
);

/**
 * What was observed about an action Aval took, and whether it proves the
 * action's claim.
 *
 * A task that caused an external effect holds at `PENDING_VERIFICATION` until
 * something independent says the effect took hold. Without this table that
 * state could only ever expire into a human handoff, which is honest but is
 * not verification. Each row is one observation: a provider re-read, a webhook,
 * a person confirming, a document, or Aval's own state — compared against the
 * state the action expected.
 *
 * `verificationResult` is the comparison's outcome, not the observation's
 * quality. An observation that positively shows the action did *not* happen is
 * `contradicted`, which is a successful verification of a failure.
 */
export const actionEvidence = sqliteTable(
  "action_evidence",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    taskId: text("task_id").notNull().references(() => agentTasks.id),
    /** The execution this is evidence about — the idempotency key the executor reserved. */
    actionExecutionId: text("action_execution_id").notNull(),
    /** The tool whose effect is being verified. */
    toolName: text("tool_name").notNull(),
    /** What Aval claims happened, in one line, for a person reading the trail. */
    claim: text("claim").notNull(),
    expectedStateJson: text("expected_state_json").notNull().default("{}"),
    /** provider_reread | provider_event | human_confirmation | document | aval_native */
    evidenceType: text("evidence_type").notNull(),
    sourceProvider: text("source_provider"),
    externalRecordId: text("external_record_id"),
    observedStateJson: text("observed_state_json").notNull().default("{}"),
    /** When the observation was true at its source, where that is knowable. */
    observedAt: integer("observed_at", { mode: "timestamp_ms" }),
    /** confirmed | contradicted | inconclusive */
    verificationResult: text("verification_result").notNull(),
    /** Pointer to a stored payload; never the payload itself, which may hold resident data. */
    payloadRef: text("payload_ref"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("action_evidence_task_idx").on(table.organizationId, table.taskId),
    index("action_evidence_execution_idx").on(table.actionExecutionId),
    // A provider can deliver the same webhook twice, and a scheduled re-read can
    // race one. The same observation of the same execution is one row.
    uniqueIndex("action_evidence_observation_uq").on(
      table.actionExecutionId, table.evidenceType, table.externalRecordId, table.verificationResult,
    ),
    check("action_evidence_type", sql`evidence_type IN ('provider_reread','provider_event','human_confirmation','document','aval_native')`),
    check("action_evidence_result", sql`verification_result IN ('confirmed','contradicted','inconclusive')`),
  ],
);

/**
 * Attempt budgets, as configuration rather than as constants in the runtime.
 *
 * `kind` keeps the three budgets apart — how long a provider is waited on,
 * how many times an answer may be repaired, and how many times a goal may be
 * re-planned are different questions, and one must never become the ceiling on
 * another. A null selector means "any"; the most specific matching row wins,
 * and a workspace with no rows at all behaves exactly as the shipped defaults.
 */
export const attemptPolicies = sqliteTable(
  "attempt_policies",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    /** verification | check_repair | replan */
    kind: text("kind").notNull(),
    /** Selectors. Null means "any"; a row applies only where every named selector matches. */
    provider: text("provider"),
    toolName: text("tool_name"),
    workType: text("work_type"),
    riskClass: text("risk_class"),
    /** Null caps nothing by count. Legitimate for work that must wait until a person intervenes. */
    maxAttempts: integer("max_attempts"),
    /** Null caps nothing by elapsed time. */
    maxElapsedMs: integer("max_elapsed_ms"),
    initialDelayMs: integer("initial_delay_ms").notNull().default(0),
    /** fixed | linear | exponential */
    backoffStrategy: text("backoff_strategy").notNull().default("fixed"),
    backoffFactor: real("backoff_factor").notNull().default(2),
    maxDelayMs: integer("max_delay_ms"),
    /** human_handoff | replan | fail — what happens when the budget is spent. */
    onExhausted: text("on_exhausted").notNull().default("human_handoff"),
    /** human_handoff | replan | fail — what happens when the provider says it did not take hold. */
    onContradicted: text("on_contradicted").notNull().default("human_handoff"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("attempt_policies_lookup_idx").on(table.organizationId, table.kind, table.enabled),
    // One row per selector shape per budget, so "most specific wins" never has
    // two candidates of equal specificity to choose between.
    uniqueIndex("attempt_policies_selector_uq").on(
      table.organizationId, table.kind, table.provider, table.toolName, table.workType, table.riskClass,
    ),
    check("attempt_policies_kind", sql`kind IN ('verification','check_repair','replan')`),
    check("attempt_policies_backoff", sql`backoff_strategy IN ('fixed','linear','exponential')`),
    check("attempt_policies_on_exhausted", sql`on_exhausted IN ('human_handoff','replan','fail')`),
    check("attempt_policies_on_contradicted", sql`on_contradicted IN ('human_handoff','replan','fail')`),
    check("attempt_policies_attempts_positive", sql`max_attempts IS NULL OR max_attempts >= 1`),
    check("attempt_policies_elapsed_positive", sql`max_elapsed_ms IS NULL OR max_elapsed_ms >= 0`),
    check("attempt_policies_delay_nonnegative", sql`initial_delay_ms >= 0`),
    check("attempt_policies_factor_positive", sql`backoff_factor > 0`),
  ],
);

/**
 * What was tried, and what was learned from it.
 *
 * A replan that cannot see the previous attempt can only guess, and guessing
 * produces the loop this table exists to break: strategy A, fail, replan,
 * strategy A. Each row is one attempt at the objective — an execution, a
 * verification sweep, a repair, or a replan — with enough structure for the
 * next planning pass to choose differently on purpose.
 *
 * `signature` is what makes repetition detectable: a digest of the tool, its
 * canonical arguments and the failure. Two attempts with the same signature
 * tried the same thing and got the same answer. `transient` is what keeps a
 * legitimate retry — a rate limit, a provider that has not caught up — from
 * being mistaken for a loop.
 */
export const workAttempts = sqliteTable(
  "work_attempts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    taskId: text("task_id").notNull().references(() => agentTasks.id),
    /** The employee that made the attempt. Null until employees exist as records. */
    employeeId: text("employee_id"),
    attemptNumber: integer("attempt_number").notNull(),
    /** execution | verification | check_repair | replan */
    kind: text("kind").notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    /** The objective as it stood for this attempt, so a later change of goal stays legible. */
    objectiveSnapshot: text("objective_snapshot"),
    strategy: text("strategy"),
    actionsJson: text("actions_json").notNull().default("[]"),
    toolsJson: text("tools_json").notNull().default("[]"),
    delegationsJson: text("delegations_json").notNull().default("[]"),
    observations: text("observations"),
    result: text("result"),
    /** succeeded | failed | inconclusive | blocked */
    outcome: text("outcome").notNull(),
    failureReason: text("failure_reason"),
    blockerReason: text("blocker_reason"),
    /** The failure had a cause expected to pass, which is the one case where repeating verbatim is correct. */
    transient: integer("transient", { mode: "boolean" }).notNull().default(false),
    /** The attempt moved the objective: new evidence, a state change, something learned. */
    progressed: integer("progressed", { mode: "boolean" }).notNull().default(false),
    /** Digest of tool + canonical args + failure. Equal signatures mean the same thing was tried. */
    signature: text("signature"),
    learned: text("learned"),
    shouldChange: text("should_change"),
    nextStrategy: text("next_strategy"),
    costCents: integer("cost_cents"),
    tokensUsed: integer("tokens_used"),
    latencyMs: integer("latency_ms"),
    externalEffectsJson: text("external_effects_json").notNull().default("[]"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("work_attempts_task_idx").on(table.organizationId, table.taskId, table.kind),
    index("work_attempts_signature_idx").on(table.organizationId, table.taskId, table.signature),
    // Attempt numbering is the budget. Making it unique per (task, kind) is what
    // stops a crash-and-resume from spending the same attempt twice, and what
    // keeps the three budgets counted separately.
    uniqueIndex("work_attempts_number_uq").on(table.taskId, table.kind, table.attemptNumber),
    check("work_attempts_kind", sql`kind IN ('execution','verification','check_repair','replan')`),
    check("work_attempts_outcome", sql`outcome IN ('succeeded','failed','inconclusive','blocked')`),
    check("work_attempts_number_positive", sql`attempt_number >= 1`),
  ],
);

/**
 * A durable organizational actor.
 *
 * Not a model session and not a persona: an employee outlives any particular
 * run, owns Work, and carries its own authority. The eight specialists that
 * preceded this were a fixed union in source — `PersonaId` — which meant the
 * roster was a property of the build rather than of the customer. Here a role
 * is just text, because "Turnover Coordinator" is a thing a customer invents,
 * not a thing Aval ships.
 *
 * Scopes are relational (`ai_employee_scopes`) rather than folded into one
 * opaque prompt, so what an employee may reach is enforced by the backend and
 * legible to the person who granted it.
 */
export const aiEmployees = sqliteTable(
  "ai_employees",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    name: text("name").notNull(),
    /** Free text on purpose. No enum of valid roles exists, or may exist. */
    role: text("role").notNull(),
    description: text("description"),
    /** What this employee is responsible for, in the customer's own words. */
    objective: text("objective"),
    instructions: text("instructions"),
    /** draft | active | paused | archived */
    status: text("status").notNull().default("draft"),
    /** supervised | assisted | autonomous */
    autonomyMode: text("autonomy_mode").notNull().default("supervised"),
    /** Named approval policy this employee runs under. */
    approvalPolicy: text("approval_policy").notNull().default("standard"),
    /** Null means this employee commits no money at all, which is the safe default. */
    spendLimitCents: integer("spend_limit_cents"),
    /** The highest risk tier this employee may act at without a person. */
    riskCeiling: text("risk_ceiling").notNull().default("low"),
    /** organization | property | work — how widely its memory reaches. */
    memoryScope: text("memory_scope").notNull().default("work"),
    /** Creating an employee grants nothing; these are turned on deliberately. */
    mayCommunicateExternally: integer("may_communicate_externally", { mode: "boolean" }).notNull().default(false),
    mayDelegate: integer("may_delegate", { mode: "boolean" }).notNull().default(false),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("ai_employees_org_idx").on(table.organizationId, table.status),
    // One name per workspace. Duplicates are allowed by the architecture but not
    // by this table: a directory containing two employees called Maya cannot be
    // used to decide which one is waiting on you.
    uniqueIndex("ai_employees_org_name_uq").on(table.organizationId, table.name),
    check("ai_employees_status", sql`status IN ('draft','active','paused','archived')`),
    check("ai_employees_autonomy", sql`autonomy_mode IN ('supervised','assisted','autonomous')`),
    check("ai_employees_risk", sql`risk_ceiling IN ('low','medium','high','critical')`),
    check("ai_employees_memory_scope", sql`memory_scope IN ('organization','property','work')`),
    check("ai_employees_spend_nonnegative", sql`spend_limit_cents IS NULL OR spend_limit_cents >= 0`),
    check("ai_employees_name_present", sql`length(trim(name)) > 0`),
    check("ai_employees_role_present", sql`length(trim(role)) > 0`),
  ],
);

/**
 * What one employee is allowed to reach.
 *
 * One row per grant, so authority is additive, auditable and revocable a piece
 * at a time. `scope_kind` is an internal taxonomy and is constrained; the
 * values are not, because a data domain or a work type is something a customer
 * names.
 *
 * Absence is never permission: an employee with no rows of a given kind reaches
 * nothing of that kind, rather than everything.
 */
export const aiEmployeeScopes = sqliteTable(
  "ai_employee_scopes",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    employeeId: text("employee_id").notNull().references(() => aiEmployees.id),
    /** property | connection | capability | work_type | data_domain | delegate_to */
    scopeKind: text("scope_kind").notNull(),
    value: text("value").notNull(),
    grantedBy: text("granted_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("ai_employee_scopes_lookup_idx").on(table.employeeId, table.scopeKind),
    uniqueIndex("ai_employee_scopes_grant_uq").on(table.employeeId, table.scopeKind, table.value),
    check("ai_employee_scopes_kind", sql`scope_kind IN ('property','connection','capability','work_type','data_domain','delegate_to')`),
    check("ai_employee_scopes_value_present", sql`length(trim(value)) > 0`),
  ],
);

/**
 * Expertise: what an employee knows how to do, separately from who it is.
 *
 * The eight specialists conflated these. "Maintenance" was simultaneously an
 * identity, a permission envelope, a prompt fragment and a tool subset, which
 * is why handling a recurring HVAC complaint that also needs vendor
 * coordination and escalation meant either one over-broad agent or four
 * separate bots.
 *
 * An employee is the persistent worker; expertise is loaded for the work in
 * front of it. Only the routing metadata here is ever held in memory at once —
 * the instructions are read for the profiles actually selected, so a catalogue
 * of two hundred costs nothing to carry.
 */
export const expertiseProfiles = sqliteTable(
  "expertise_profiles",
  {
    id: text("id").primaryKey(),
    /** Null for the profiles Aval ships; set for one a workspace authored. */
    organizationId: text("organization_id").references(() => organizations.id),
    /** Stable handle: `resident-experience`, `vendor-coordination`. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    /* ── routing metadata: small, always loadable ─────────────────────────── */
    /** Capability tags this expertise answers to, as a JSON string array. */
    capabilityTagsJson: text("capability_tags_json").notNull().default("[]"),
    /** Business domains it belongs to, as a JSON string array. */
    domainsJson: text("domains_json").notNull().default("[]"),
    /** Words and work types that suggest it, as a JSON string array. */
    routingSignalsJson: text("routing_signals_json").notNull().default("[]"),
    /** Tools it cannot work without, as a JSON string array. Absence of one excludes it. */
    requiredCapabilitiesJson: text("required_capabilities_json").notNull().default("[]"),
    /* ── the body: read only once selected ───────────────────────────────── */
    instructions: text("instructions").notNull().default(""),
    /** Ceiling this expertise refuses to act above, whatever the employee allows. */
    riskCeiling: text("risk_ceiling").notNull().default("low"),
    version: integer("version").notNull().default(1),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("expertise_profiles_lookup_idx").on(table.organizationId, table.enabled),
    // A workspace may shadow a shipped profile with its own of the same slug;
    // it may not have two of its own.
    uniqueIndex("expertise_profiles_slug_uq").on(table.organizationId, table.slug),
    check("expertise_profiles_risk", sql`risk_ceiling IN ('low','medium','high','critical')`),
    // Valid in both dialects: GLOB is SQLite-only and would not survive the
    // Postgres generator, which copies these predicates through verbatim.
    check("expertise_profiles_slug_shape", sql`slug = lower(slug) AND length(slug) BETWEEN 2 AND 64`),
  ],
);

/**
 * Which expertise an employee is permitted to load.
 *
 * Permission, not preference: selection chooses from this set and never outside
 * it, so an employee cannot acquire a competence at runtime by being asked
 * nicely. An employee with no rows may load nothing, which makes a new employee
 * inert until somebody decides what it should know.
 */
export const employeeExpertise = sqliteTable(
  "employee_expertise",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    employeeId: text("employee_id").notNull().references(() => aiEmployees.id),
    expertiseId: text("expertise_id").notNull().references(() => expertiseProfiles.id),
    /** Pinned expertise is always loaded, whatever the work looks like. */
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    grantedBy: text("granted_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("employee_expertise_lookup_idx").on(table.employeeId),
    uniqueIndex("employee_expertise_uq").on(table.employeeId, table.expertiseId),
  ],
);

/**
 * Why a particular expertise was loaded for a particular piece of work.
 *
 * A routing decision that cannot be inspected is indistinguishable from a
 * guess. Each row records what was considered, what was chosen, on what
 * signals, by which model, and whether a person overrode it — so "why did Maya
 * treat this as an escalation" has an answer that does not require rerunning
 * anything.
 */
export const expertiseSelections = sqliteTable(
  "expertise_selections",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    taskId: text("task_id").notNull().references(() => agentTasks.id),
    employeeId: text("employee_id"),
    /** Every profile considered, with its score, as JSON. */
    candidatesJson: text("candidates_json").notNull().default("[]"),
    /** The slugs actually loaded, as a JSON string array. */
    selectedJson: text("selected_json").notNull().default("[]"),
    /** The signals that decided it, as JSON. */
    signalsJson: text("signals_json").notNull().default("{}"),
    /** deterministic | model | user — how the choice was reached. */
    decidedBy: text("decided_by").notNull(),
    modelProvider: text("model_provider"),
    modelName: text("model_name"),
    confidence: real("confidence"),
    /** Set when a person's explicit choice replaced what routing proposed. */
    overriddenBy: text("overridden_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("expertise_selections_task_idx").on(table.organizationId, table.taskId),
    check("expertise_selections_decided_by", sql`decided_by IN ('deterministic','model','user')`),
    check("expertise_selections_confidence", sql`confidence IS NULL OR (confidence >= 0 AND confidence <= 1)`),
  ],
);
