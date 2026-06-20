-- ============================================================
--  CATTLE TRACKER — Supabase database schema
--  Run this ONCE in your Supabase project:
--    Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- ============================================================

-- ---------- main table: every animal (cows AND calves) ----------
-- A calf and a cow are the same kind of record. A calf points to its
-- mother via dam_id. A cow's calves are every row whose dam_id = her id.
create table if not exists public.animals (
  id              uuid primary key default gen_random_uuid(),

  -- 10. Unique Calf ID (17-char random, permanent, survives tag swaps)
  unique_id       text unique not null,

  -- 1. Name (optional)
  name            text,

  -- 8. Calf tag number (current; changeable over time)
  tag_number      text,

  -- 11. Previous tag numbers (history; appended when tag changes)
  --     each item: { "tag": "123", "changed_on": "2026-06-20" }
  tag_history     jsonb not null default '[]'::jsonb,

  -- 2/4/5. Mother info. dam_id links to the mother's own animals row.
  --     mom_tag / mom_breed / mom_birth_year are kept as a snapshot for
  --     when the mother is not (yet) a record in the system.
  dam_id          uuid references public.animals(id) on delete set null,
  mom_tag         text,
  mom_breed       text,   -- Hereford, Black White Face, Angus, Charolais
  mom_birth_year  int,

  -- 3. Birth date (defaults to today in the app, editable)
  birth_date      date,

  -- 6. Calf breed: Hereford, Black White Face, Angus, Charolais, Other
  breed           text,

  -- 7. Gender: Heifer or Bull   (+ neutered flag if Bull)
  gender          text,   -- 'Heifer' | 'Bull'
  neutered        boolean default false,

  -- 9. Color: BWF or BLK
  color           text,

  -- Weight (lbs) — current weight + history, used for the value estimator
  weight_lbs      numeric,
  weight_history  jsonb not null default '[]'::jsonb,   -- [{ "date":"...", "lbs":520 }]

  -- Breeding date (optional) — for future calving-date predictions
  breeding_date   date,

  -- 12/13. Vaccinations. Latest is the last item; full history kept here.
  --     each item: { "date": "2026-06-20", "note": "7-way" }
  vaccinations    jsonb not null default '[]'::jsonb,

  -- 14. Photo (stored in the animal-photos storage bucket)
  photo_path      text,

  -- 15/16. Sale info (not shown on the new-calf form)
  sale_price      numeric,
  sale_date       date,

  -- 17. Notes
  notes           text,

  -- housekeeping
  is_sold         boolean generated always as (sale_date is not null) stored,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists animals_dam_idx        on public.animals(dam_id);
create index if not exists animals_tag_idx         on public.animals(tag_number);
create index if not exists animals_birth_year_idx  on public.animals(birth_date);

-- safe to re-run: adds newer columns to an existing install
alter table public.animals add column if not exists weight_lbs     numeric;
alter table public.animals add column if not exists weight_history jsonb not null default '[]'::jsonb;
alter table public.animals add column if not exists breeding_date  date;

-- keep updated_at fresh
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

drop trigger if exists animals_touch on public.animals;
create trigger animals_touch
  before update on public.animals
  for each row execute function public.touch_updated_at();

-- ---------- Row Level Security ----------
-- Single shared login: any signed-in user has full access. Nothing is
-- readable by the anonymous public.
alter table public.animals enable row level security;

drop policy if exists "signed-in full access" on public.animals;
create policy "signed-in full access"
  on public.animals
  for all
  to authenticated
  using (true)
  with check (true);

-- ============================================================
--  STORAGE: photo bucket
--  Easiest path: create the bucket in the dashboard UI instead.
--    Storage -> New bucket -> name: animal-photos -> Public bucket: ON
--  The policies below let signed-in users upload/replace photos.
-- ============================================================
insert into storage.buckets (id, name, public)
values ('animal-photos', 'animal-photos', true)
on conflict (id) do nothing;

drop policy if exists "photos readable" on storage.objects;
create policy "photos readable"
  on storage.objects for select
  using ( bucket_id = 'animal-photos' );

drop policy if exists "photos writable by signed-in" on storage.objects;
create policy "photos writable by signed-in"
  on storage.objects for insert to authenticated
  with check ( bucket_id = 'animal-photos' );

drop policy if exists "photos updatable by signed-in" on storage.objects;
create policy "photos updatable by signed-in"
  on storage.objects for update to authenticated
  using ( bucket_id = 'animal-photos' );

drop policy if exists "photos deletable by signed-in" on storage.objects;
create policy "photos deletable by signed-in"
  on storage.objects for delete to authenticated
  using ( bucket_id = 'animal-photos' );
