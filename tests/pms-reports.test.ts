import test from 'node:test';
import assert from 'node:assert/strict';
import {mapPmsReport,parseReportCsv} from '../lib/operations/pms-reports.ts';
import {demoPortfolio} from '../lib/operations/demo-portfolio.ts';
import {planImport} from '../lib/operations/import-plan.ts';

test('report CSV preserves quoted commas, multiline cells and escaped quotes',()=>{
  assert.deepEqual(parseReportCsv('ID,Name\r\n1,"A, B"\r\n2,"C\n""D"""').rows,[['1','A, B'],['2','C\n"D"']]);
  for(const value of ['ID,ID\n1,2','ID,Name\n1','ID\n"open','ID\n"x"bad'])assert.throws(()=>parseReportCsv(value));
});
test('report mapping uses provider-separated IDs but cannot assign provenance',()=>{
  const mapping={externalId:'ID',propertyExternalId:'Property',unitNumber:'Unit'};
  const csv='ID,Property,Unit\n5,01,101';
  assert.deepEqual(mapPmsReport('appfolio','units',csv,mapping,'USD').units,[{externalId:'appfolio:report:5',propertyExternalId:'appfolio:report:01',unitNumber:'101'}]);
  assert.throws(()=>mapPmsReport('yardi','units',csv,{...mapping,sourceProvider:'ID'},'USD'));
  assert.throws(()=>mapPmsReport('yardi','units',csv,mapping,'MXN'));
  assert.throws(()=>mapPmsReport('quickbooks','units',csv,mapping,'USD'));
});
test('fractional cents are rejected rather than rounded',()=>{
  assert.throws(()=>mapPmsReport('yardi','ledgerEntries','ID,Amount\na,1.25',{externalId:'ID',amountCents:'Amount'},'USD'));
});
test('demo portfolio is deterministic, valid, linked and contains exact USD exceptions',()=>{
  const data=demoPortfolio(new Date('2026-09-26T01:00:00Z'));
  assert.deepEqual(data,demoPortfolio(new Date('2026-09-26T22:00:00Z')));
  assert.equal(data.properties?.length,3);assert.equal(data.units?.length,24);assert.equal(data.residents?.length,18);
  assert.deepEqual(planImport(data).skipped,[]);
  assert.equal(data.ledgerEntries?.reduce((n,row)=>n+(row.entryType==='payment'?-1:1)*row.amountCents,0),175000);
  assert.equal(data.leases?.filter(l=>l.endDate!<'2026-12-25').length,3);
});
