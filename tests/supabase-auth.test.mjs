// Include Supabase Auth transport regressions in the default unit suite.
import "./integration/module-hooks.mjs";
await import("./integration/supabase-auth.integration.mjs");
