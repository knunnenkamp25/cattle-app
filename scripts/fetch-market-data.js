/* ============================================================
   fetch-market-data.js
   Pulls Virginia + mid-Atlantic USDA/VDACS cattle auction reports
   and cattle news, builds market-data.json for the app.
   Runs daily via GitHub Actions. No API key required.
   Node 20+ (uses global fetch). No npm dependencies.
   ============================================================ */
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "market-data.json");

// VDACS publishes Richmond, VA livestock reports as plain-text files that
// are overwritten with the latest each week at a stable URL. We scan a range
// of report codes and keep whichever currently contain cattle prices.
const VDACS_CODES = [];
for (let i = 145; i <= 162; i++) VDACS_CODES.push("rh_ls" + i);

const MONTHS = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };

async function getText(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "cattle-tracker/1.0" } });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

function parseDate(text) {
  // matches "May 15, 2026"
  const m = text.match(/([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return null;
  const mo = MONTHS[m[1]]; if (mo == null) return null;
  const d = new Date(Date.UTC(+m[3], mo, +m[2]));
  return d.toISOString().slice(0, 10);
}

function parseReport(code, text) {
  if (!text || !/head/i.test(text) || /<html/i.test(text)) return null;
  const lines = text.split(/\r?\n/);
  const location = (lines[1] || "").split(/\s{2,}/)[0].trim() || "Virginia";
  // auction name: first substantive title line after the header
  let name = "";
  for (let i = 2; i < Math.min(lines.length, 8); i++) {
    const t = lines[i].trim();
    if (t && !/prices|weekly auction|daily|^all /i.test(t)) { name = t; break; }
  }
  const saleDate = parseDate(text);
  const headMatch = text.match(/Feeder Cattle\s+([\d,]+)\s+head/i) || text.match(/Cattle\s+([\d,]+)\s+head/i);
  const head = headMatch ? parseInt(headMatch[1].replace(/,/g, ""), 10) : null;

  // walk lines, tracking broad type + first subclass per type
  let broad = null, sub = null, seenSubForType = {};
  const cats = [];                 // {type, w1, w2, low, high}
  const steer56 = [];              // midpoints for statewide series

  const typeOf = (l) => {
    if (/Feeder Holstein/i.test(l)) return null;            // skip holstein
    if (/Feeder Steers/i.test(l)) return "Steers";
    if (/Feeder Heifers/i.test(l)) return "Heifers";
    if (/Feeder Bulls/i.test(l)) return "Bulls";
    return null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const t = typeOf(line);
    // subclass header (indented, has grade words, no price)
    if (t && /Medium|Large|Small|Choice|Select/i.test(line) && !/\d+\.\d/.test(line)) {
      broad = t;
      if (!seenSubForType[t]) { seenSubForType[t] = (sub = line.trim()); }
      else sub = null;             // ignore later subclasses for this type
      continue;
    }
    // broad header line e.g. "Feeder Steers   400 head"
    if (t && /head/i.test(line)) { broad = t; continue; }
    // price row: "  500- 600    440.00-480.00"
    const pm = line.match(/^\s*(\d{2,4})\s*-\s*(\d{2,4})\s+(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?/);
    if (pm && broad && sub && !/per (head|pair)/i.test(line)) {
      const w1 = +pm[1], w2 = +pm[2], low = +pm[3], high = pm[4] ? +pm[4] : +pm[3];
      if ([400, 500, 600].includes(w1) && (w2 - w1) === 100) {
        cats.push({ type: broad, w1, w2, low, high });
      }
      if (broad === "Steers" && w1 === 500 && w2 === 600) steer56.push((low + high) / 2);
    }
  }

  const categories = cats.map(c => ({
    label: `${c.type} ${c.w1}-${c.w2} lb`,
    low: c.low.toFixed(0), high: c.high.toFixed(0),
  }));

  if (!categories.length && !steer56.length) return null;
  return {
    code: code.toUpperCase(),
    name: name || "Virginia Auction",
    location, report_date: saleDate || "",
    head, categories,
    _steer56avg: steer56.length ? steer56.reduce((a, b) => a + b, 0) / steer56.length : null,
  };
}

async function getNews() {
  const queries = [
    "Virginia cattle market prices",
    "mid-Atlantic cattle feeder prices",
    "cattle market beef prices USDA",
  ];
  const items = [];
  for (const q of queries) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
    const xml = await getText(url);
    if (!xml) continue;
    const blocks = xml.split("<item>").slice(1);
    for (const b of blocks.slice(0, 8)) {
      const get = (tag) => { const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return m ? m[1] : ""; };
      let title = get("title").replace(/<!\[CDATA\[|\]\]>/g, "").trim();
      const link = get("link").replace(/<!\[CDATA\[|\]\]>/g, "").trim();
      const source = get("source").replace(/<[^>]+>/g, "").replace(/<!\[CDATA\[|\]\]>/g, "").trim();
      const pub = get("pubDate").trim();
      let date = "";
      if (pub) { const d = new Date(pub); if (!isNaN(d)) date = d.toISOString().slice(0, 10); }
      // title often ends with " - Source"
      let src = source;
      if (!src && / - [^-]+$/.test(title)) { src = title.split(" - ").pop(); title = title.replace(/ - [^-]+$/, ""); }
      if (title && link) items.push({ title, url: link, source: src, date });
    }
  }
  // dedupe by title, newest first
  const seen = new Set(), out = [];
  items.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  for (const it of items) { const k = it.title.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(it); } }
  return out.slice(0, 12);
}

(async () => {
  console.log("Fetching VDACS reports…");
  const reports = [];
  for (const code of VDACS_CODES) {
    const text = await getText(`https://www.vdacs.virginia.gov/doc/${code}.txt`);
    const r = parseReport(code, text);
    if (r) { reports.push(r); console.log("  ✓", r.code, r.name, r.report_date, r._steer56avg ? `(steer5-6 ~$${r._steer56avg.toFixed(0)})` : ""); }
  }

  // statewide feeder steer 500-600 average for the most recent report week
  const withAvg = reports.filter(r => r._steer56avg != null);
  let pointDate = "", pointPrice = null;
  if (withAvg.length) {
    pointPrice = withAvg.reduce((a, r) => a + r._steer56avg, 0) / withAvg.length;
    pointDate = withAvg.map(r => r.report_date).filter(Boolean).sort().pop() || new Date().toISOString().slice(0, 10);
  }

  // merge into existing time series (one point per report-week date)
  let prev = { series: [] };
  try { prev = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch {}
  let series = Array.isArray(prev.series) ? prev.series : [];
  if (pointPrice != null && pointDate) {
    series = series.filter(p => p.date !== pointDate);
    series.push({ date: pointDate, price: +pointPrice.toFixed(2) });
    series.sort((a, b) => a.date.localeCompare(b.date));
    series = series.slice(-180);
  }

  console.log("Fetching news…");
  const news = await getNews().catch(() => []);

  const auctions = reports
    .sort((a, b) => (b.report_date || "").localeCompare(a.report_date || ""))
    .slice(0, 10)
    .map(({ _steer56avg, ...rest }) => rest);

  const data = { updated: new Date().toISOString(), series, auctions, news };
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
  console.log(`Wrote ${OUT}: ${auctions.length} auctions, ${series.length} price points, ${news.length} news items.`);
})();
