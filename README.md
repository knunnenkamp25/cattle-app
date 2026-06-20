# 🐄 Cattle Tracker

A simple, phone-and-iPad-friendly app to record calves, manage the herd, track
finances, and watch Virginia / mid-Atlantic cattle markets — all stored in the
cloud so it's available anywhere with an internet connection.

- **App** = these files, hosted free on **GitHub Pages**.
- **Data + photos** = **Supabase** (free hosted database + file storage + one shared login).
- **Market prices & news** = a **GitHub Action** that refreshes automatically every day.

You set this up once (about 20 minutes). After that, your father-in-law just opens
the web address on his iPhone/iPad, signs in once, and adds it to his home screen
like a normal app.

---

## What it does

- **Add Calf** — a quick form with tap-to-select buttons (no typing for breed, gender,
  color, neutered). Birth date defaults to today. A permanent 17-character Unique ID is
  generated automatically so an animal can be followed even as ear tags are swapped/reused.
  Take or upload a photo right from the phone.
- **The Herd** — search every animal by tag, name, breed, color, or ID. Filter to
  in-herd / mothers / sold. Open any animal to see its full profile.
- **Animal profile** — edit details, **change tag** (keeps a tag history), **add
  vaccination dates** (keeps a full history), **record a sale**, and see the animal's
  **mother** (tap to jump to her) and **all of her calves** (tap any to jump to it).
- **Home / Dashboard** — herd overview (head count, new calves this year, bulls vs.
  heifers, % bulls intact, vaccinated this year), finances (avg sale price + totals for
  the last 90 days and last 12 months), and an **alert center** (not-vaccinated-this-year,
  intact bulls, missing tags).
- **Market & News** — auto-updating Virginia & mid-Atlantic feeder/slaughter auction
  prices, a price-trend chart, and the latest cattle-market headlines.
- **Herd value estimator** — add a weight to an animal and the app multiplies it by the
  live market $/cwt (matched to its class + weight band) to show its estimated value, plus a
  total **estimated herd value** on the dashboard.
- **QR ear-tag labels** — print QR labels for one animal or a whole filtered list (Herd tab →
  Tools → "Print QR tags"). Scan one with the phone camera in the field and it opens that
  animal's profile instantly.
- **Export & backup** — one-tap CSV of sales (for taxes) or full herd inventory, plus a
  JSON backup you can download and later restore (Herd tab → Tools).
- **Weekly reminder email** *(optional)* — an automatic Monday email summarizing what needs
  attention (not-vaccinated, intact bulls, missing tags). Setup in step 7.
- **Works offline** — out in the field with no signal, he can still open the app, browse
  the herd, add calves, change tags, log vaccinations, record sales, and snap photos.
  Everything is saved on the device and **syncs automatically** the moment signal returns.
  A small pill in the top bar shows the status (Offline · 2, Syncing…, Synced); tap it to
  sync on demand.

---

## Setup — do this once

### 1. Create the Supabase project (the cloud database)

1. Go to **https://supabase.com** → sign up (free) → **New project**.
   Give it a name, set a database password (save it somewhere), pick a region near you.
2. When it finishes building, open **SQL Editor** → **New query**.
3. Open the file **`supabase-schema.sql`** from this folder, copy everything, paste it
   in, and click **Run**. This creates the `animals` table, security rules, and the photo
   storage bucket.
4. Go to **Project Settings → API** and copy two values:
   - **Project URL**
   - **Project API keys → `anon` `public`**

### 2. Create the shared login

1. In Supabase, go to **Authentication → Users → Add user → Create new user**.
2. Enter the email + password your family will share. Tick **Auto Confirm User**.
   (That email/password is what gets typed on the app's sign-in screen.)
3. *(Recommended)* Under **Authentication → Sign In / Providers → Email**, turn
   **OFF** "Allow new users to sign up" so only the account you created can log in.

### 3. Put your keys into the app

Open **`config.js`** and paste your two values:

```js
SUPABASE_URL:      "https://xxxxxxxx.supabase.co",
SUPABASE_ANON_KEY: "eyJhbGciOi...your anon key...",
```

These two values are safe to publish — the database is protected by the login + security
rules you ran in step 1.

### 4. Put the app on GitHub Pages (free hosting)

1. Create a GitHub account if needed → **New repository** (e.g. `cattle-tracker`).
   It can be **public** (required for free Actions + Pages) — your keys are safe to publish.
2. Upload **all the files in this folder** to the repository (drag-and-drop on
   github.com works: "Add file → Upload files"). Keep the folder structure, including the
   `.github/workflows` and `scripts` folders.
3. In the repo: **Settings → Pages → Build and deployment → Source: "Deploy from a
   branch"**, Branch: `main`, folder: `/ (root)` → **Save**.
4. After a minute, your app is live at:
   `https://YOUR-USERNAME.github.io/cattle-tracker/`

### 5. Turn on the daily market updater

1. In the repo, open the **Actions** tab → if prompted, enable workflows.
2. Click **"Update market data" → Run workflow** to populate prices/news right away.
   (After that it runs by itself every morning.)
3. If the push step ever fails with a permissions error: **Settings → Actions → General →
   Workflow permissions → "Read and write permissions" → Save**, then run it again.

### 6. Add it to his iPhone / iPad home screen

1. Open the app's web address in **Safari**.
2. Tap the **Share** button → **Add to Home Screen** → **Add**.
3. It now opens full-screen like a normal app. He signs in once and stays signed in.

### 7. (Optional) Turn on the weekly reminder email

This sends an automatic Monday summary of anything needing attention. Skip it if you
don't want emails.

1. In Supabase: **Project Settings → API → `service_role` key** — copy it. **This key is
   powerful and secret — never put it in `config.js` or any committed file.** It only goes
   in GitHub *secrets*, which are encrypted.
2. In your GitHub repo: **Settings → Secrets and variables → Actions → New repository
   secret**, and add these:
   - `SUPABASE_URL` — your project URL
   - `SUPABASE_SERVICE_KEY` — the service_role key from step 1
   - `REMINDER_TO` — where to send (e.g. `ken@example.com`)
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` — your email login. For Gmail,
     use host `smtp.gmail.com`, port `465`, your address as user, and a Google
     **App Password** (not your normal password) as pass.
   - `REMINDER_FROM` *(optional)* — defaults to `SMTP_USER`.
3. **Actions tab → "Weekly herd reminder email" → Run workflow** to test it now.

---

## Everyday use

- Tap **Add Calf**, fill in the form (most fields are one tap), **Save**.
- To link a calf to its mother, type her tag in the **Mother** search box and pick her.
  If she isn't in the system yet, just fill in her tag/breed/year — the app creates her
  record automatically so future calves can be linked to her.
- To change an ear tag later, open the animal → **Change tag** (the old tag is saved to
  history). To record shots, open the animal → **Add date** under Vaccinations.
- To sell, open the animal → **Record sale** (price + date). Sold animals drop out of the
  live herd counts but stay in records and feed the finance numbers.

---

## Notes & ideas for later

- **Where the market data comes from:** USDA / Virginia Dept. of Agriculture (VDACS)
  Market News public auction reports + Google News. No API key needed. Adjust the report
  codes or news searches in `scripts/fetch-market-data.js`.
- **Costs:** Supabase free tier and GitHub Pages/Actions free tier are plenty for one
  family herd. No credit card required.
- **How offline works (for the curious):** the app shell is cached by a service worker
  (`sw.js`); the herd is mirrored to the device, and any change made offline goes into a
  local "outbox" (`offline.js`) that flushes to Supabase when the connection returns.
  Photos taken offline are held on the device and uploaded on sync. New records get their
  permanent ID generated on the device, so links between cows and calves work offline too.
- **Possible additions:** weaning-weight growth charts (ADG), breeding/calving due-date
  predictions & reminders, treatment/withdrawal-date tracking, and multi-user logins (so
  you can see who entered what).
