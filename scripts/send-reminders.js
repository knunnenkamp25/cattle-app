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
const vaxThisYear = (a) => (a.vaccinations || []).some(v => v.date && new Date(v.date).getFullYear() === yr);

(async () => {
  // pull herd via Supabase REST (service role bypasses row-level security)
  const res = await fetch(`${SUPABASE_URL}/rest/v1/animals?select=*`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  if (!res.ok) { console.error("Supabase fetch failed:", res.status, await res.text()); process.exit(1); }
  const animals = await res.json();
  const live = animals.filter(a => !a.sale_date);

  const noVax = live.filter(a => !vaxThisYear(a));
  const intactBulls = live.filter(a => a.gender === "Bull" && !a.neutered);
  const noTag = live.filter(a => !a.tag_number);
  const newCalves = live.filter(a => a.birth_date && new Date(a.birth_date).getFullYear() === yr);

  const nothing = !noVax.length && !intactBulls.length && !noTag.length;
  const name = (a) => a.tag_number ? `Tag ${a.tag_number}` : (a.name || a.unique_id);
  const li = (arr) => arr.slice(0, 40).map(a => `<li>${name(a)}${a.name && a.tag_number ? " (" + a.name + ")" : ""}</li>`).join("");
  const block = (title, arr) => arr.length ? `<h3 style="margin:18px 0 6px">${title} — ${arr.length}</h3><ul style="margin:0">${li(arr)}</ul>` : "";

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:560px">
    <h2 style="color:#4a6b3a">🐄 Weekly Herd Reminder</h2>
    <p style="color:#555">${new Date().toLocaleDateString()} · ${live.length} head in herd · ${newCalves.length} new calves in ${yr}</p>
    ${nothing
      ? `<p style="font-size:16px;color:#4a6b3a"><b>✅ All clear — nothing needs attention this week.</b></p>`
      : `${block("💉 Not vaccinated this year", noVax)}
         ${block("🐂 Intact bulls", intactBulls)}
         ${block("🏷️ Missing a tag number", noTag)}`}
    <p style="margin-top:22px;color:#888;font-size:12px">Sent automatically by your Cattle Tracker.</p>
  </div>`;

  const transport = nodemailer.createTransport({
    host: SMTP_HOST, port: Number(SMTP_PORT) || 587, secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  await transport.sendMail({
    from: REMINDER_FROM || SMTP_USER,
    to: REMINDER_TO,
    subject: `🐄 Herd reminder — ${nothing ? "all clear" : (noVax.length + intactBulls.length + noTag.length) + " items"}`,
    html,
  });
  console.log(`Reminder sent to ${REMINDER_TO} (${noVax.length} unvax, ${intactBulls.length} intact bulls, ${noTag.length} no tag).`);
})().catch(e => { console.error(e); process.exit(1); });
