// Include transport regressions in the default unit suite without network calls.
import './integration/module-hooks.mjs';
await import('./integration/provider-http.integration.mjs');
