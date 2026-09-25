/**
 * Panels that exist for us, not for the person using Aval.
 *
 * The PMS work — the seat address, the desktop session, the capability matrix,
 * the provider workflows — is built and testable but not something a customer
 * should meet on the integrations page while it still says things like
 * "simulator only". Deleting the render would mean editing code to test it
 * again, so it is gated instead: the panels appear for `?preview=pms` and for
 * nobody else.
 *
 * This is a visibility gate, never an authorization one. Everything behind it
 * is still subject to the same session, role and org checks it always was, so
 * guessing the parameter reveals a panel, not a permission.
 */
export const PREVIEW_PARAM = "preview";

export function internalPreview(search: string, name: string): boolean {
  return new URLSearchParams(search).get(PREVIEW_PARAM) === name;
}
