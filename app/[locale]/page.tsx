import type { DbSession } from "@/db/postgres/session";
import { withPageSession } from "@/lib/api/with-session";
import { getPageIdentity } from "@/lib/integrations/session";
import { PasswordRecoveryScreen, SignInScreen } from "@/app/components/auth-gate";
import { AvalDashboard } from "./dashboard-client";

async function HomeWithSession(dbSession: DbSession, { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  if (params.signin !== undefined) return <SignInScreen recoveryError={params.recoveryError !== undefined} />;

  const identity = await getPageIdentity(dbSession);
  if (!identity || identity.source === "guest") return <SignInScreen />;
  if (params.recovery !== undefined) return <PasswordRecoveryScreen />;
  // The workspace's creation date (for "day N with Aval") is deliberately NOT
  // resolved here: it would put another database query on every dashboard load for a
  // secondary figure, and pull the database binding into a page that otherwise
  // server-renders without one. The hero fetches it from /api/workspace after
  // paint instead — the greeting and typed line render immediately either way.
  return <AvalDashboard requestedView={typeof params.view === "string" ? params.view : undefined} authMode={identity.source} displayName={identity.displayName} email={identity.email} />;
}

export default async function Home(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await props.searchParams;
  if (params.signin !== undefined) return <SignInScreen recoveryError={params.recoveryError !== undefined} />;
  return (await withPageSession((session) => HomeWithSession(session, props))) ?? <SignInScreen />;
}
