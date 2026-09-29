// Table export: Markdown and CSV (to the clipboard) and a real Excel workbook
// (.xlsx). No library: an .xlsx file is a zip of a few XML files, written here
// with the zip "store" method (no compression needed).
//
// columns: [{ label, get(row) }] — get returns a string, number, Date or empty.

const cellValue = (c, row) => {
  const v = c.get(row);
  return v == null || (typeof v === 'number' && !Number.isFinite(v)) ? '' : v;
};
const pad = (n) => String(n).padStart(2, '0');
/** Local "2026-09-27 14:03:22", the way people read timestamps in a sheet or a message. */
export const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const text = (v) => (v instanceof Date ? stamp(v) : String(v));

// ── Markdown ────────────────────────────────────────────────────────────────
export function toMarkdown(columns, rows) {
  // A line break of any kind (\r\n, \n or a lone \r) would end the table row.
  const esc = (v) => text(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>');
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(columns.map((c) => esc(c.label))), line(columns.map((c) => (rows.some((r) => typeof cellValue(c, r) === 'number') ? '---:' : '---'))), ...rows.map((r) => line(columns.map((c) => esc(cellValue(c, r)))))].join('\n');
}

// ── CSV (RFC 4180) ──────────────────────────────────────────────────────────
// Paths, user agents and log lines come from outside. A text cell that starts like a formula
// (= + - @, or a tab or carriage return) would run as one when the file is opened in a
// spreadsheet, so it gets a leading ' (which makes it plain text). Numbers stay numbers.
const FORMULA = /^[=+\-@\t\r]/;

export function toCsv(columns, rows) {
  const esc = (v) => {
    let s = text(v);
    if (typeof v === 'string' && FORMULA.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map((c) => esc(c.label)).join(','), ...rows.map((r) => columns.map((c) => esc(cellValue(c, r))).join(','))].join('\r\n');
}

// ── Excel (.xlsx) ───────────────────────────────────────────────────────────
// Text goes in as inline strings, which Excel never evaluates, so no formula guard is needed here.
const xml = (s) =>
  String(s)
    // Characters XML 1.0 doesn't allow at all (log lines can contain them): C0 controls other
    // than tab, LF and CR, U+FFFE/U+FFFF, and unpaired surrogate halves.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|\p{Cs}/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const colName = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** Excel's day number for a local date and time (days since 1899-12-30). */
const excelDate = (d) => (d.getTime() - d.getTimezoneOffset() * 60_000) / 86_400_000 + 25569;

function sheetXml(columns, rows) {
  const widths = columns.map((c) => Math.min(60, Math.max(8, c.label.length + 2)));
  const cell = (ref, v, header) => {
    if (header) return `<c r="${ref}" t="inlineStr" s="1"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
    if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
    if (v instanceof Date) return `<c r="${ref}" s="2"><v>${excelDate(v)}</v></c>`;
    if (v === '') return '';
    const s = String(v).slice(0, 32_000); // Excel's per-cell limit is 32,767 characters
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(s)}</t></is></c>`;
  };
  const body = [];
  body.push(`<row r="1">${columns.map((c, i) => cell(`${colName(i)}1`, c.label, true)).join('')}</row>`);
  rows.forEach((r, ri) => {
    const cells = columns.map((c, i) => {
      const v = cellValue(c, r);
      const len = v instanceof Date ? 19 : String(v).length;
      if (len + 2 > widths[i]) widths[i] = Math.min(60, len + 2);
      return cell(`${colName(i)}${ri + 2}`, v);
    });
    body.push(`<row r="${ri + 2}">${cells.join('')}</row>`);
  });
  const last = `${colName(columns.length - 1)}${rows.length + 1}`;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${body.join('')}</sheetData>` +
    `<autoFilter ref="A1:${last}"/>` +
    '</worksheet>'
  );
}

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

export function toXlsx(columns, rows, sheetName = 'Sheet1') {
  // Excel's rules for sheet names: no []:*?/\, at most 31 characters, not empty, no ' at either end.
  const name =
    xml(
      String(sheetName)
        .replace(/[[\]:*?/\\]/g, ' ')
        .slice(0, 31),
    )
      .replace(/^'+|'+$/g, '')
      .trim() || 'Sheet1';
  const files = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${name.replace(/'/g, "''")}'!$A$1:$${colName(columns.length - 1)}$${rows.length + 1}</definedName></definedNames></workbook>`],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml', STYLES],
    ['xl/worksheets/sheet1.xml', sheetXml(columns, rows)],
  ];
  return zipStore(files.map(([path, content]) => [path, new TextEncoder().encode(content)]));
}

// ── Zip (store method) ──────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(entries) {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [path, data] of entries) {
    const name = new TextEncoder().encode(path);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    locals.push(new Uint8Array(local.buffer), name, data);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, time, true);
    central.setUint16(14, date, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = centrals.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, at), (at += p.length);
  return out;
}
