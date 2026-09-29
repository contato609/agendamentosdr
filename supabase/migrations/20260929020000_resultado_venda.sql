-- ════════════════════════════════════════════════════════════════════════════
-- Resultado comercial da visita comparecida: vendeu / não vendeu + VGV
-- ════════════════════════════════════════════════════════════════════════════
alter table public.visits
  add column if not exists sale_status text check (sale_status in ('vendeu', 'nao_vendeu')),
  add column if not exists vgv         numeric(14, 2) check (vgv is null or vgv >= 0),
  add column if not exists sale_notes  text,
  add column if not exists sale_at     timestamptz;

create index if not exists visits_sale_status_idx on public.visits (sale_status);
