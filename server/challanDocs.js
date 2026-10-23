'use strict';

// Dispatch paperwork as A4 HTML, rendered to PDF by challanPdf.js so the
// download looks the same whatever printer or viewer the user has.
//
// - Challan: travels with the goods (issuer letterhead, party, transport,
//   items and quantities, signatures). Quantities only, no prices.
// - Receiving slip: for the receiving site to fill in what actually arrived
//   and sign, against the same challan number.

const esc = (v) =>
    String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

const fmtQty = (n) => Number(n || 0).toLocaleString('en-IN');

function fmtDate(v) {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '';
    // Rendered on the server (UTC), so pin the date to India time.
    return d
        .toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' })
        .replace(/\//g, '-');
}

function packText(l) {
    if (l.pack_qty && l.pack_size && l.pack_size > 1) return `${fmtQty(l.pack_qty)} × ${fmtQty(l.pack_size)}`;
    return '';
}

function unitTotals(lines) {
    const m = new Map();
    for (const l of lines) m.set(l.unit, (m.get(l.unit) || 0) + Number(l.qty || 0));
    return [...m.entries()].map(([u, q]) => `${fmtQty(q)} ${esc(u)}`).join(' · ');
}

const fmtMoney = (n) =>
    Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const hasRate = (l) => l.rate != null && Number.isFinite(Number(l.rate));
const lineAmount = (l) => (hasRate(l) ? Math.round(Number(l.qty || 0) * Number(l.rate) * 100) / 100 : null);

// Value of the priced lines, and how many lines have no rate yet.
function priceTotals(lines) {
    let amount = 0;
    let unpriced = 0;
    for (const l of lines) {
        const a = lineAmount(l);
        if (a == null) unpriced += 1;
        else amount += a;
    }
    return { amount: Math.round(amount * 100) / 100, unpriced };
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
    'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function under100(n) {
    return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
}

function under1000(n) {
    const h = Math.floor(n / 100);
    const r = n % 100;
    return [h ? `${ONES[h]} Hundred` : '', r ? under100(r) : ''].filter(Boolean).join(' ');
}

// Indian numbering (Crore, Lakh, Thousand), as on the reference voucher.
function wholeInWords(n) {
    if (n === 0) return 'Zero';
    const parts = [];
    const crore = Math.floor(n / 10000000);
    if (crore) parts.push(`${wholeInWords(crore)} Crore`);
    const lakh = Math.floor((n % 10000000) / 100000);
    if (lakh) parts.push(`${under100(lakh)} Lakh`);
    const thousand = Math.floor((n % 100000) / 1000);
    if (thousand) parts.push(`${under100(thousand)} Thousand`);
    const rest = n % 1000;
    if (rest) parts.push(under1000(rest));
    return parts.join(' ');
}

function rupeesInWords(amount) {
    const paise = Math.round(amount * 100);
    const r = Math.floor(paise / 100);
    const p = paise % 100;
    return `Rupees ${wholeInWords(r)}${p ? ` and Paisa ${under100(p)}` : ''} Only`;
}

// Rate and amount cells for a line, when the document shows prices.
function priceCells(l) {
    return `
      <td class="num">${hasRate(l) ? fmtMoney(l.rate) : '—'}</td>
      <td class="num">${hasRate(l) ? fmtMoney(lineAmount(l)) : '—'}</td>`;
}

const PRICE_HEADS = '<th class="num">Rate (₹)</th><th class="num">Amount (₹)</th>';

// Grand total in rupees with the amount in words, as on the reference voucher.
function grandTotal(lines, label = 'Grand Total') {
    const t = priceTotals(lines);
    const note = t.unpriced
        ? ` <small>(${t.unpriced} item${t.unpriced === 1 ? '' : 's'} without a rate not included)</small>`
        : '';
    return `
  <div class="grand"><span>${esc(label)}</span><span>₹ ${fmtMoney(t.amount)}</span></div>
  <div class="words">${esc(rupeesInWords(t.amount))}${note}</div>`;
}

const BASE_CSS = `
@page { size: A4; margin: 12mm; }
* { box-sizing: border-box; }
body { margin: 0; font: 11pt/1.35 Arial, "Liberation Sans", Helvetica, "DejaVu Sans", sans-serif; color: #111; }
.sheet { border: 1.5px solid #111; }
.head { text-align: center; padding: 8px 12px 10px; border-bottom: 1.5px solid #111; }
.doc-title { font-size: 13pt; font-weight: 700; text-decoration: underline; letter-spacing: .02em; margin: 0 0 4px; }
.org { font-size: 20pt; font-weight: 700; margin: 0; letter-spacing: .02em; }
.org-sub { font-size: 9.5pt; font-weight: 700; margin: 2px 0 0; }
.meta { display: grid; grid-template-columns: 1.05fr 1fr; border-bottom: 1.5px solid #111; }
.meta > div { padding: 8px 12px; min-height: 120px; }
.meta > div + div { border-left: 1.5px solid #111; }
.label { font-weight: 700; font-style: italic; margin: 0 0 4px; }
.party-name { font-weight: 700; margin: 0 0 2px; }
.kv { display: grid; grid-template-columns: 9.5em 1em 1fr; row-gap: 3px; font-size: 10pt; }
.kv b { font-weight: 400; }
table.items { width: 100%; border-collapse: collapse; font-size: 10pt; }
table.items th { text-align: left; font-weight: 700; padding: 6px 6px; border-bottom: 1.5px solid #111; }
table.items td { padding: 5px 6px; vertical-align: top; }
table.items th + th, table.items td + td { border-left: 1px solid #111; }
table.items .num { text-align: right; white-space: nowrap; }
table.items .sn { width: 2.5em; }
table.items tr.fill td { height: 160px; }
.total { display: flex; justify-content: space-between; gap: 12px; padding: 7px 12px; border-top: 1.5px solid #111; font-weight: 700; }
.note { padding: 6px 12px; border-top: 1.5px solid #111; font-size: 9.5pt; }
.sign { display: grid; grid-template-columns: 1fr 1fr; border-top: 1.5px solid #111; }
.sign > div { padding: 10px 12px 12px; min-height: 92px; display: flex; flex-direction: column; justify-content: space-between; }
.sign > div + div { border-left: 1.5px solid #111; text-align: right; }
.foot { display: flex; justify-content: space-between; font-size: 8.5pt; color: #555; margin-top: 4px; }
.blank { border-bottom: 1px solid #111; min-width: 9em; display: inline-block; }
.check { display: flex; gap: 22px; padding: 8px 12px; border-top: 1.5px solid #111; font-size: 10pt; }
.box { display: inline-block; width: 11px; height: 11px; border: 1px solid #111; margin-right: 6px; vertical-align: -1px; }
.fields { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 24px; padding: 12px; border-top: 1.5px solid #111; font-size: 10pt; }
.fields div { display: flex; gap: 8px; align-items: flex-end; }
.fields .line { flex: 1; border-bottom: 1px solid #111; height: 1.2em; }
.grand { display: grid; grid-template-columns: 1fr auto; border-top: 1.5px solid #111; font-weight: 700; }
.grand > span { padding: 7px 12px; }
.grand > span + span { border-left: 1.5px solid #111; min-width: 11em; text-align: right; }
.words { padding: 6px 12px; border-top: 1.5px solid #111; font-weight: 700; font-size: 10pt; }
.words small { font-weight: 400; color: #444; }
`;

function letterhead(c, title) {
    const org = c.org || {};
    const sub = [org.address, org.phone ? `Phone: ${org.phone}` : null].filter(Boolean).map(esc).join(' · ');
    return `
<div class="head">
  <p class="doc-title">${esc(title)}</p>
  <p class="org">${esc((org.name || '').toUpperCase())}</p>
  ${sub ? `<p class="org-sub">${sub}</p>` : ''}
  ${org.licence_no ? `<p class="org-sub">Drug Licence No. : ${esc(org.licence_no)}</p>` : ''}
  ${org.gst ? `<p class="org-sub">GST : ${esc(org.gst)}</p>` : ''}
</div>`;
}

function partyBlock(c) {
    const d = c.details || {};
    const to = c.to || {};
    // The challan keeps its own copy of the site's details; the saved
    // delivery site fills in for challans made before it had them.
    const address = d.party_address || to.address || '';
    const contact = [d.contact_name || to.contact_name, d.contact_phone || to.contact_phone].filter(Boolean);
    return `
  <div>
    <p class="label">Party Details :</p>
    <p class="party-name">${esc(to.name || '')}${to.bu_code && to.bu_code !== to.name ? ` (${esc(to.bu_code)})` : ''}</p>
    ${address ? `<div>${esc(address).replace(/\n/g, '<br>')}</div>` : ''}
    ${contact.length ? `<p style="margin-top:6px">Contact : ${contact.map(esc).join(' · ')}</p>` : ''}
    <p style="margin-top:${contact.length ? 4 : 14}px">Party D.L. No. : ${esc(d.party_licence || to.licence_no || '')}</p>
  </div>`;
}

function challanHtml(c) {
    const d = c.details || {};
    const lines = c.lines || [];
    // Price columns appear once any line has a rate; quantities only otherwise.
    const priced = lines.some(hasRate);
    const rows = lines
        .map(
            (l, i) => `<tr>
      <td class="sn">${i + 1}.</td>
      <td>${esc(l.material_name)}</td>
      <td class="num">${esc(packText(l))}</td>
      <td class="num">${fmtQty(l.qty)}</td>
      <td>${esc(l.unit)}</td>${priced ? priceCells(l) : ''}
    </tr>`
        )
        .join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Challan ${esc(c.number)}</title><style>${BASE_CSS}</style></head><body>
<div class="sheet">
  ${letterhead(c, 'DELIVERY CHALLAN · MATERIAL ISSUED TO PARTY')}
  <div class="meta">
    ${partyBlock(c)}
    <div class="kv">
      <span>No.</span><span>:</span><b>${esc(c.number)}</b>
      <span>Dated</span><span>:</span><b>${esc(fmtDate(c.occurred_at))}</b>
      <span>From</span><span>:</span><b>${esc((c.from && c.from.name) || '')}</b>
      <span>GR/RR No.</span><span>:</span><b>${esc(d.gr_no || '')}</b>
      <span>Transport</span><span>:</span><b>${esc(d.transport || '')}</b>
      <span>Vehicle No.</span><span>:</span><b>${esc(d.vehicle_no || '')}</b>
      <span>Station</span><span>:</span><b>${esc(d.station || '')}</b>
      <span>E-Way Bill No.</span><span>:</span><b>${esc(d.eway_bill || '')}</b>
    </div>
  </div>
  <table class="items">
    <thead><tr><th class="sn">S.N.</th><th>Description of Goods</th><th class="num">Packs</th><th class="num">Qty.</th><th>Unit</th>${priced ? PRICE_HEADS : ''}</tr></thead>
    <tbody>${rows}<tr class="fill">${'<td></td>'.repeat(priced ? 7 : 5)}</tr></tbody>
  </table>
  <div class="total"><span>Total: ${lines.length} item${lines.length === 1 ? '' : 's'}</span><span>${unitTotals(lines)}</span></div>
  ${priced ? grandTotal(lines) : ''}
  ${c.reference || c.note ? `<div class="note">${c.reference ? `Ref: ${esc(c.reference)}` : ''}${c.reference && c.note ? ' · ' : ''}${esc(c.note || '')}</div>` : ''}
  <div class="sign">
    <div><span>Received the above goods in good condition</span><span>Receiver's signature &amp; stamp</span></div>
    <div><span><b>for ${esc((c.org && c.org.name) || '')}</b></span><span><b>Authorised Signatory</b></span></div>
  </div>
</div>
<div class="foot"><span>Delivery challan · ${esc((c.org && c.org.name) || '')} · Material transfer, not a sale</span><span>Challan No. ${esc(c.number)}</span></div>
</body></html>`;
}

function receivingHtml(c) {
    const lines = c.lines || [];
    const priced = lines.some(hasRate);
    const rows = lines
        .map(
            (l, i) => `<tr>
      <td class="sn">${i + 1}.</td>
      <td>${esc(l.material_name)}</td>
      <td class="num">${fmtQty(l.qty)}</td>
      <td>${esc(l.unit)}</td>${priced ? priceCells(l) : ''}
      <td></td>
      <td></td>
    </tr>`
        )
        .join('');
    const org = c.org || {};
    return `<!doctype html><html><head><meta charset="utf-8"><title>Receiving slip ${esc(c.number)}</title><style>${BASE_CSS}
table.items td { height: 26px; }
</style></head><body>
<div class="sheet">
  ${letterhead(c, 'MATERIAL RECEIVING SLIP')}
  <div class="meta">
    ${partyBlock(c)}
    <div class="kv">
      <span>Against Challan</span><span>:</span><b>No. ${esc(c.number)}</b>
      <span>Challan date</span><span>:</span><b>${esc(fmtDate(c.occurred_at))}</b>
      <span>Sent from</span><span>:</span><b>${esc((c.from && c.from.name) || '')}</b>
      <span>Transport</span><span>:</span><b>${esc((c.details && c.details.transport) || '')}</b>
      <span>GR/RR No.</span><span>:</span><b>${esc((c.details && c.details.gr_no) || '')}</b>
    </div>
  </div>
  <table class="items">
    <thead><tr><th class="sn">S.N.</th><th>Item</th><th class="num">Qty. sent</th><th>Unit</th>${priced ? PRICE_HEADS : ''}<th style="width:7em">Qty. received</th><th style="width:${priced ? 9 : 12}em">Remarks (short / damaged)</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${priced ? grandTotal(lines, 'Value sent') : ''}
  <div class="check">
    <span><span class="box"></span>All items received in good condition</span>
    <span><span class="box"></span>Short / damaged (see remarks)</span>
  </div>
  <div class="fields">
    <div><span>Received on (date &amp; time)</span><span class="line"></span></div>
    <div><span>Received by (name)</span><span class="line"></span></div>
    <div><span>Phone</span><span class="line"></span></div>
    <div><span>Signature &amp; stamp</span><span class="line"></span></div>
  </div>
  <div class="note">Please sign and return this slip, or send a clear photo of it, to ${esc(org.phone ? org.name || 'the sender' : (org.name || 'the sender').replace(/\.+$/, ''))}${org.phone ? ` (${esc(org.phone)})` : ''}.</div>
</div>
<div class="foot"><span>Receiving slip · ${esc(org.name || '')}</span><span>Against Challan No. ${esc(c.number)}</span></div>
</body></html>`;
}

module.exports = { challanHtml, receivingHtml, rupeesInWords };
