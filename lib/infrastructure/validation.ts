export class UtilityError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export function textField(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new UtilityError(`Invalid ${field}`);
  return value.trim();
}
export function validateUnit(type: string, unit: string) {
  const allowed: Record<string,string[]> = { electricity: ["kWh"], water: ["m3","gal","ccf"], gas: ["m3","ccf","therm"] };
  if (!allowed[type]?.includes(unit)) throw new UtilityError("Unit does not match utility type");
}
export function dateField(value: unknown, field: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new UtilityError(`Invalid ${field}: use YYYY-MM-DD`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== value) throw new UtilityError(`Invalid ${field}`);
  return date;
}
export function numericField(value: unknown, field: string, integer = false, max = 10000000000) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isSafeInteger(value))) throw new UtilityError(`Invalid ${field}`);
  return value;
}
export function validateBill(input: Record<string,unknown>) {
  const meterId = textField(input.meterId,"meterId");
  const periodStart = dateField(input.periodStart,"periodStart");
  const periodEnd = dateField(input.periodEnd,"periodEnd (exclusive)");
  if (periodEnd <= periodStart) throw new UtilityError("periodEnd must follow periodStart");
  const usageAmount = numericField(input.usageAmount,"usageAmount",false,100000000);
  if (Math.abs(usageAmount * 1e6 - Math.round(usageAmount * 1e6)) > 0.01) throw new UtilityError("Usage supports at most six decimal places");
  const costCents = numericField(input.costCents,"costCents",true);
  if (input.currency !== "USD" && input.currency !== "MXN") throw new UtilityError("Specify MXN or USD explicitly");
  const readingKind = input.readingKind ?? "unknown";
  if (!["actual","estimated","unknown"].includes(String(readingKind))) throw new UtilityError("Invalid readingKind");
  const subtotalCents = input.subtotalCents == null ? null : numericField(input.subtotalCents,"subtotalCents",true);
  const taxCents = input.taxCents == null ? null : numericField(input.taxCents,"taxCents",true);
  if ((subtotalCents === null) !== (taxCents === null) || (subtotalCents !== null && subtotalCents + taxCents! !== costCents)) throw new UtilityError("Subtotal plus tax must equal invoice total; omit both when unavailable");
  return { meterId, periodStart, periodEnd, usageAmount, costCents, currency: input.currency as "USD" | "MXN",
    unitOfMeasure: textField(input.unitOfMeasure,"unitOfMeasure"), readingKind: String(readingKind),
    tariffCode: input.tariffCode ? textField(input.tariffCode,"tariffCode",100) : null, subtotalCents, taxCents };
}
export function utilityErrorResponse(error: unknown) {
  if (error instanceof UtilityError) {
    const translations: Record<string,string> = {
      "Preview changed; review it again before importing":"La vista previa cambió. Revísela otra vez antes de importar.",
      "Specify MXN or USD explicitly":"Especifique MXN o USD explícitamente.",
      "Unit does not match utility type":"La unidad no corresponde al tipo de servicio.",
      "Bill unit differs from meter unit":"La unidad del recibo no coincide con la del medidor.",
      "Site not found":"No se encontró el sitio.","Property not found":"No se encontró la propiedad.","Meter not found":"No se encontró el medidor.",
      "Mapped site cannot be reassigned":"Un medidor vinculado no puede cambiar de sitio.",
      "Parent meter must measure the same utility type":"El medidor principal debe medir el mismo tipo de servicio.",
      "Parent meter must belong to the same site":"El medidor principal debe pertenecer al mismo sitio.",
      "Meter hierarchy cycle":"La relación entre medidores crearía un ciclo.",
      "Evidence changed or unavailable; refresh the investigation":"La evidencia cambió o no está disponible. Actualice la investigación.",
      "Subtotal plus tax must equal invoice total; omit both when unavailable":"El subtotal más impuestos debe coincidir con el total. Omita ambos si no están disponibles.",
      "periodEnd must follow periodStart":"La fecha final debe ser posterior a la inicial.",
    };
    let errorEs=translations[error.message] ?? "Revise el formato, las fechas, las unidades y los identificadores del archivo.";
    const correction=error.message.match(/supersedesBillId=(.+)$/);
    if(correction)errorEs=`El recibo ya existe con otros valores. Para corregirlo, indique supersedesBillId=${correction[1]}.`;
    if(error.message.startsWith("Map the meter"))errorEs="Vincule el medidor a un sitio antes de importar.";
    if(error.message.startsWith("Meter unit mismatch"))errorEs="La unidad del archivo no coincide con la del medidor.";
    return Response.json({ error: error.message,errorEs },{ status: error.status });
  }
  console.error("utility_operation_failed", { name: error instanceof Error ? error.name : "UnknownError" });
  return Response.json({ error: "Utility operation failed",errorEs:"No se pudo completar la operación de servicios." }, { status: 500 });
}

export async function readUtilityBody(request: Request, maxBytes=20000): Promise<Record<string,unknown>> {
  const raw=await request.text();
  if(new TextEncoder().encode(raw).length>maxBytes)throw new UtilityError("Request too large",413);
  let body:unknown;
  try{body=JSON.parse(raw);}catch{throw new UtilityError("Invalid JSON");}
  if(!body || typeof body!=="object" || Array.isArray(body))throw new UtilityError("Invalid request");
  return body as Record<string,unknown>;
}
