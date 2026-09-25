# Dashboard capability map

The existing Operations cards and `DataChart` are shared by the Overview, Properties, Leasing, Maintenance, and Accounting views. The state is resolved for each metric and chart from verified workspace connections, a completed initial import where one is required, Aval-native records, and the actual result. This is a runtime state; in a workspace with no connections or native records, every row below is **PREVIEW**.

| Metric or chart | Required capabilities | Current state rule | Unlock CTA |
| --- | --- | --- | --- |
| Overview NOI; cash flow; income mix; accounting property profit | `accounting.read` | QuickBooks completed import or native GL transaction → LIVE/EMPTY; connected import pending → SYNCING; otherwise PREVIEW | Connect accounting |
| Overview collection rate; Accounting billed, collected, past due, collection rate; receivables aging | `ledger.read` | Native ledger records → LIVE/EMPTY; otherwise PREVIEW. QuickBooks GL import does not provide tenant ledger entries. | Connect accounting |
| Overview physical occupancy; Properties units, occupied, available; occupancy by type | `unit.read`, `lease.read` | Buildium completed import or native units and leases → LIVE/EMPTY; pending import → SYNCING; otherwise PREVIEW | Connect property system |
| Properties count | `property.read` | Buildium completed import or native property → LIVE/EMPTY; pending import → SYNCING; otherwise PREVIEW | Connect property system |
| Properties rent position | `unit.read`, `lease.read` | Same source gate as occupancy; actual rent result decides LIVE/EMPTY | Connect leasing data |
| Leasing stage metrics and funnel; lease expirations | `lead.read`, `lease.read` | Native leads plus leases, or any future implemented importer of both → LIVE/EMPTY; otherwise PREVIEW | Connect leasing data |
| Overview open work orders; Maintenance reported, open, completed, emergency; work by category; maintenance spend | `work.read` | Buildium completed import or Aval-native work order → LIVE/EMPTY; pending import → SYNCING; otherwise PREVIEW | Connect property system |
| Resident communication domain (used by capability resolver; no new dashboard card added) | `message.read` | Connected inbox provider → LIVE/EMPTY according to queried result; otherwise PREVIEW | Connect inbox |

`LIVE/EMPTY` means a successful query with nonzero/zero results respectively. The Connections catalog opens filtered to the relevant category so users can choose among its providers. Only Buildium's implemented property import and QuickBooks' implemented GL import currently grant those reporting capabilities. A connected PMS whose import is not implemented does not unlock unrelated or unpopulated reports. No new demo dashboard or business values are used for preview geometry.
