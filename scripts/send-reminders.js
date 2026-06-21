/* ============================================================
   send-reminders.js
   Weekly herd health/admin reminder email.
   Reads the herd from Supabase (service role key) and emails a
   summary of anything that needs attention. Runs via GitHub Actions.

   Required environment variables (set as GitHub Actions secrets):
     SUPABASE_URL           your project URL
     SUPABASE_SERVICE_KEY   Project Settings -> API -> service_role key (SECRET!)
     REMINDER_TO            where to send (e.g. ken@example.com; comma-separated ok)
     SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS   your email/SMTP login
     REMINDER_FROM          (optional) from address; defaults to SMTP_USER
   ============================================================ */
const nodemailer = require("nodemailer");

const {
  SUPABASE_URL, SUPABASE_SERVICE_KEY, REMINDER_TO,
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, REMINDER_FROM,
} = process.env;

function need(v, name) { if (!v) { console.error("Missing env: " + name); process.exit(0); } }
need(SUPABASE_URL, "SUPABASE_URL");
need(SUPABASE_SERVICE_KEY, "SUPABASE_SERVICE_KEY");
need(REMINDER_TO, "REMINDER_TO");
need(SMTP_HOST, "SMTP_HOST"); need(SMTP_USER, "SMTP_USER"); need(SMTP_PASS, "SMTP_PASS");

const yr = new Date().getFullYear();
const DAY = 86400000;
const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const addDays = (iso, days) => { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + Number(days || 0)); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const vaxRecent = (a) => (a.vaccinations || []).some(v => v.date && (Date.now() - new Date(v.date + "T00:00:00").getTime()) <= 365 * DAY);
function withdrawalUntil(a) { let m = null; (a.treatments || []).forEach(t => { const wd = Number(t.withdrawal_days); if (t.date && wd > 0) { const c = addDays(t.date, wd); if (!m || c > m) m = c; } }); return m; }
const inWithdrawal = (a) => { const u = withdrawalUntil(a); return !!(u && u >= todayISO()); };
const calvingDue = (a) => a.breeding_date ? addDays(a.breeding_date, 283) : null;
const calvingSoon = (a) => { const d = calvingDue(a); return d && d >= addDays(todayISO(), -14) && d <= addDays(todayISO(), 21); };

(async () => {
  // pull herd via Supabase REST (service role bypasses row-level security)
  const res = await fetch(`${SUPABASE_URL}/rest/v1/animals?select=*`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  if (!res.ok) { console.error("Supabase fetch failed:", res.status, await res.text()); process.exit(1); }
  const animals = await res.json();
  const live = animals.filter(a => !a.sale_date && !a.death_date);   // in-herd = not sold and not deceased

  const noVax = live.filter(a => !vaxRecent(a));                       // no vaccination in the last 12 months
  const intactBulls = live.filter(a => a.gender === "Bull" && !a.neutered);
  const noTag = live.filter(a => !a.tag_number);
  const calving = live.filter(calvingSoon);
  const withdrawing = live.filter(inWithdrawal);
  const newCalves = live.filter(a => a.birth_date && Number(String(a.birth_date).slice(0, 4)) === yr);

  const nothing = !noVax.length && !intactBulls.length && !noTag.length && !calving.length && !withdrawing.length;
  const name = (a) => a.tag_number ? `Tag ${a.tag_number}` : (a.name || a.unique_id);
  const li = (arr, extra) => arr.slice(0, 40).map(a => `<li>${name(a)}${a.name && a.tag_number ? " (" + a.name + ")" : ""}${extra ? extra(a) : ""}</li>`).join("");
  const block = (title, arr, extra) => arr.length ? `<h3 style="margin:18px 0 6px">${title} — ${arr.length}</h3><ul style="margin:0">${li(arr, extra)}</ul>` : "";

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:560px">
    <h2 style="color:#4a6b3a">🐄 Weekly Herd Reminder</h2>
    <p style="color:#555">${new Date().toLocaleDateString()} · ${live.length} head in herd · ${newCalves.length} new calves in ${yr}</p>
    ${nothing
      ? `<p style="font-size:16px;color:#4a6b3a"><b>✅ All clear — nothing needs attention this week.</b></p>`
      : `${block("🐄 Calving soon", calving, a => ` — due ~${calvingDue(a)}`)}
         ${block("⏳ In medication withdrawal (do not sell)", withdrawing, a => ` — until ${withdrawalUntil(a)}`)}
         ${block("💉 Not vaccinated in the last year", noVax)}
         ${block("🐂 Intact bulls", intactBulls)}
         ${block("🏷️ Missing a tag number", noTag)}`}
    <p style="margin-top:22px;color:#888;font-size:12px">Sent automatically by your Cattle Tracker.</p>
  </div>`;

  const items = noVax.length + intactBulls.length + noTag.length + calving.length + withdrawing.length;
  const transport = nodemailer.createTransport({
    host: SMTP_HOST, port: Number(SMTP_PORT) || 587, secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  await transport.sendMail({
    from: REMINDER_FROM || SMTP_USER,
    to: REMINDER_TO,
    subject: `🐄 Herd reminder — ${nothing ? "all clear" : items + " items"}`,
    html,
  });
  console.log(`Reminder sent to ${REMINDER_TO} (${noVax.length} unvax, ${intactBulls.length} intact bulls, ${noTag.length} no tag, ${calving.length} calving, ${withdrawing.length} withdrawal).`);
})().catch(e => { console.error(e); process.exit(1); });
