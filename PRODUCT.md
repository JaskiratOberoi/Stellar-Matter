# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Store operators** (e.g. the Rohtak Warehouse team) receive stock from vendors, dispatch it to business units and labs, and log purchase orders. They work on phones on the warehouse floor and at BU counters as much as at a desk; the app is installed as a PWA titled "Inventory". Role `operator`.
- **Admins** reconcile stock, void wrong entries, manage the catalog (materials, locations, vendors) and run Tracer sweeps to plan demand. Role `admin` / `super_admin`.
- **Viewers** read balances and history without recording anything. Role `viewer`.

Confirmed in session: named operators and admins exist; the primary design target is the operator recording movements, with admins as the second audience. *(Inferred, not user-stated: the exact proportion of phone vs. desk use.)*

## Product Purpose

Stellar Matter is the official tally of physical materials for Qugen Pathlabs' Genomics business: letterheads, envelopes, barcode labels, vials, tubes, containers and consumables. It records every receipt, dispatch and adjustment in an append-only ledger and derives stock on hand at every location from it, so balances can never drift from history. Success is an operator recording a movement in under a minute, an admin trusting the on-hand figure without a recount, and the monthly Tracer sweep telling the business how much of each material each unit will consume.

## Positioning

Balances are never stored, only derived: a void or correction removes the entry from the ledger and every figure recomputes. And demand is not guessed — the Tracer reads the LIS itself (test results per sample) and converts it into counts of letterheads, envelopes, vials and tubes per business unit, so ordering is driven by real workload.

## Operating Context

- Two central **stores** (Rohtak Warehouse, Ares Office Delhi) and ~90 **business units / labs** across north India (BU codes like AGRA, KARNAL, SRINAGAR; client codes like Dl0298; rider/team names). Stock flows store → BU/lab; BU-to-BU transfers happen; vendors sometimes ship **direct to a BU** (no store leg).
- Receipts arrive as packs ("20 boxes of 100"); the ledger stores pack size and count and moves the base units. Proof photos are attached per line.
- Purchase orders are placed with vendors and tracked to delivery; a proforma invoice (PI) PDF accompanies an order. Receiving an order books its lines into stock.
- The **Tracer** queries the lab information system (Listec bridge → Noble MSSQL) for a date window and set of business units or sales scopes, and produces per-unit counts for letterheads, envelopes, urine containers, EDTA / flouride / citrate / heparin vials, LBC, barcode and serum. Results are printed or saved as PDF for planning.
- Business-unit names come from the LIS master and have two spellings (code and name); the app presents each unit once.
- Deployed as a static frontend on Hostinger and a Node API + Postgres + Listec bridge in Docker; the LIS database is read-only for this product and any object added there must be additive.

## Capabilities and Constraints

- Ledger kinds: `receipt` (into a location), `dispatch` (between locations, may overdraw the source by design so unrecorded stock still moves), `adjustment` (one side, exempt from the negative-stock guard). Voids are soft (`voided_at`) and refuse to overdraw a downstream location unless forced.
- Materials carry a base unit, default pack size and reorder level; "below reorder" counts store stock only.
- Locations: `store`, `business_unit`, `lab`; BUs sync from the LIS lookup; labs may carry an MCC client code.
- Vendors carry contact, GST and the materials they supply.
- Orders (confirmed 2026-09-15): anyone who can move stock may log one; status is `placed` → `received` or `cancelled`, set manually; one expected delivery date; one PI PDF per order, replaceable; an optional destination (store, or a BU for direct dispatch); receiving an order pre-fills the Receive form and the resulting receipt links back to the order.
- Roles gate writes: viewer reads; operator moves stock and logs orders; admin manages the catalog and vendors; super_admin manages users and organisations. Every mutation is audited.
- Constraints: the LIS is production-critical and shared — read-only access, additive objects only, deployed file by file with approval. Never `docker compose build` from an unmerged branch (it builds the working tree). Pushing `main` deploys the frontend.
- Terminology: **SID** = sample id; **BU** = business unit; **MCC code** = client/lab code; **docket** = the summary beside a form; **tile / block** = one unit's Tracer result; **collate** = merge selected units into one SID-deduplicated result.
- Undecided: multi-organisation use beyond `org-default`; whether orders should carry prices; whether Tracer results should feed reorder suggestions automatically.

## Brand Commitments

- Name: **Stellar Matter**; tagline in the topbar: "Official tally for materials in Genomics". Wordmark set in uppercase mono.
- Mark: the stock-grid glyph (`web/public/favicon.svg`, `web/src/components/BrandMark.jsx`) — two bars on a baseline with a tick, lime on near-black.
- The chosen and shipped visual world is **Lab Bench** (see DESIGN.md); the user picked it over a light "Daylight" alternative and a task-first "Field Card" alternative on 2026-09-08. Keep it unless asked to change.
- Voice: plain, operational, honest about state ("last run failed · 13:23", "18 voided, excluded from stock"). No marketing register.

## Evidence on Hand

- Live production data: 55 materials, ~92 locations, 13 vendors, ~500 ledger entries, 18 voided (September 2026).
- Tracer sweeps over 18 business units complete in ~16 s; the design canvas comparing the three directions is at https://claude.ai/code/artifact/2085dddc-1756-48ed-810f-5036ab340bc1.
- No testimonials, customer logos or benchmarks exist; do not fabricate any.

## Product Principles

1. **The ledger is the truth.** Never store a balance; never delete history; make corrections visible.
2. **Say what the number is.** Every figure carries its scope and caveat (which locations, what's excluded, when it was computed).
3. **Fast on the floor.** An operator with one thumb and a bright room must be able to record a movement without hunting.
4. **Real demand, not estimates.** Counts come from the LIS; the app shows how it got them.
5. **Touch the LIS as little as possible.** Read-only, additive, reversible.

## Accessibility & Inclusion

Used on phones under fluorescent and daylight conditions; text contrast in the dark theme is kept at ≥ 4.5:1 for the smallest labels, hit targets ≥ 44 px on phone layouts, and every table degrades to stacked cards at phone width rather than a sideways scroll.
