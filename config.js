// ============================================================
//  CONFIG — fill in the two values from your Supabase project.
//  Supabase dashboard -> Project Settings -> API
//    * Project URL          -> SUPABASE_URL
//    * Project API keys -> "anon public"  -> SUPABASE_ANON_KEY
//
//  These two values are SAFE to commit publicly. The anon key only
//  works for people who are signed in, because Row Level Security
//  (set up by supabase-schema.sql) blocks everyone else.
// ============================================================
window.CATTLE_CONFIG = {
  SUPABASE_URL: "PASTE_YOUR_SUPABASE_URL_HERE",
  SUPABASE_ANON_KEY: "PASTE_YOUR_SUPABASE_ANON_KEY_HERE",

  // Breed options (edit if you like)
  MOM_BREEDS: ["Hereford", "Black White Face", "Angus", "Charolais"],
  CALF_BREEDS: ["Hereford", "Black White Face", "Angus", "Charolais", "Other"],
  COLORS: ["BWF", "BLK"],

  // The market tab reads this file, refreshed daily by the GitHub Action.
  MARKET_DATA_URL: "market-data.json",
};
