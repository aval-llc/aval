import { ByDesignError, readByDesignCollection, type ByDesignReadConfig, type ByDesignCredentials, type ByDesignFetch } from "./odata.ts";
import { mapByDesignUtilityRows, type ByDesignUtilityProfile } from "./utility-mapping.ts";

/** Preparation only. The caller must review rows through Aval's existing
 * preview/apply endpoints after this network operation has finished. */
export async function prepareByDesignUtilityImport(config: ByDesignReadConfig, credentials: ByDesignCredentials, profile: ByDesignUtilityProfile, fetcher?: ByDesignFetch) {
  if (config.companyFilter.field !== profile.fields.company || config.companyFilter.value !== profile.companyId ||
    Object.values(profile.fields).some(field => !config.select.includes(field))) throw new ByDesignError("PROFILE_READ_SCOPE_MISMATCH");
  const source = await readByDesignCollection(config, credentials, fetcher);
  const rows = mapByDesignUtilityRows(source.rows, profile);
  return {
    rows,
    evidence: { product: source.product, fetchedAt: source.fetchedAt, pages: source.pages, rowCount: rows.length, liveSapValidated: false as const },
  };
}
