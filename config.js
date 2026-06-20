// ============================================================
//  CONFIG — Supabase project values.
//  These two values are SAFE to commit publicly. The key only
//  works for people who are signed in, because Row Level Security
//  blocks everyone else.
// ============================================================
window.CATTLE_CONFIG = {
  SUPABASE_URL: "https://pnileizziwrhwefnzicz.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_cxrTsmvBy7_utuMeosQNfQ_ws_iAk0B",

  // Breed options (edit if you like)
  MOM_BREEDS: ["Hereford", "Black White Face", "Angus", "Charolais"],
  CALF_BREEDS: ["Hereford", "Black White Face", "Angus", "Charolais", "Other"],
  COLORS: ["BWF", "BLK"],

  // The market tab reads this file, refreshed daily by the GitHub Action.
  MARKET_DATA_URL: "market-data.json",
};
