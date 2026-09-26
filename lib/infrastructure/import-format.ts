import { UtilityError } from "./validation.ts";

/** Small RFC4180 reader. No spreadsheets/formulas are evaluated. */
export function parseUtilityCsv(text: string): Record<string,unknown>[] {
  if (text.length > 500000) throw new UtilityError("CSV exceeds 500 KB");
  const lines: string[][] = []; let row: string[] = [], value = "", quoted = false, closed = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i=0;i<text.length;i++) {
    const c=text[i];
    if (quoted) {
      if (c==='"' && text[i+1]==='"') { value+='"'; i++; }
      else if(c==='"') {quoted=false;closed=true;}
      else value+=c;
    } else if(c===',' || c==='\n' || c==='\r') {
      row.push(value);value="";closed=false;
      if(c!==',') { if(c==='\r' && text[i+1]==='\n')i++; if(row.some(x=>x!==""))lines.push(row);row=[]; }
    } else if(c==='"' && value==="" && !closed) quoted=true;
    else { if(closed || c==='"')throw new UtilityError("Malformed CSV quoting");value+=c; }
  }
  if(quoted)throw new UtilityError("Unclosed CSV quote");
  row.push(value);if(row.some(x=>x!==""))lines.push(row);
  const headers=lines.shift();
  if(!headers || new Set(headers).size!==headers.length || headers.some(h=>!h))throw new UtilityError("CSV needs unique headers");
  const allowed=new Set(["sourceSystem","externalId","meterId","periodStart","periodEnd","usageAmount","costCents","currency","unitOfMeasure","readingKind","tariffCode","subtotalCents","taxCents","supersedesBillId"]);
  if(headers.some(h=>!allowed.has(h)))throw new UtilityError("Unknown CSV column");
  return lines.map(values=>{
    if(values.length!==headers.length)throw new UtilityError("CSV column count mismatch");
    return Object.fromEntries(headers.map((h,i)=>{
      const value=values[i];
      if(["usageAmount","costCents","subtotalCents","taxCents"].includes(h)) {
        if(value==="" && (h==="subtotalCents" || h==="taxCents")) return [h,null];
        if(!/^\d+(\.\d+)?$/.test(value))throw new UtilityError(`Invalid numeric CSV field: ${h}`);
        return [h,Number(value)];
      }
      return [h,value];
    }));
  });
}
