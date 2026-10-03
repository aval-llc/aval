/** Retired: protocol 1 cannot authenticate the privileged desktop runner. */
export async function POST() {
  return Response.json({error:'Update Aval Desktop. PMS writes now require the supervised browser protocol.'},{status:426});
}
