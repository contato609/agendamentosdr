-- ════════════════════════════════════════════════════════════════════════════
-- Digital Moon — Sistema de Visitas Garantidas
-- Tabelas: profiles (SDRs), products (empreendimentos), visits (visitas)
-- ════════════════════════════════════════════════════════════════════════════

-- ── Perfis (1:1 com auth.users) ─────────────────────────────────────────────
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '',
  email       text,
  role        text not null default 'sdr' check (role in ('sdr', 'admin')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Cria o perfil automaticamente quando um usuário é criado no Auth.
-- O nome vem de raw_user_meta_data->>'full_name' (preencha ao convidar/criar).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.email,
    case when new.raw_app_meta_data->>'role' = 'admin' then 'admin' else 'sdr' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean
language sql stable
security definer set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- ── Produtos (empreendimentos imobiliários) ─────────────────────────────────
create table if not exists public.products (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  location    text,
  color       text not null default '#378ADD',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ── Visitas ──────────────────────────────────────────────────────────────────
-- status: agendada → realizada (compareceu) | nao_compareceu (no-show)
create table if not exists public.visits (
  id                uuid primary key default gen_random_uuid(),
  product_id        uuid not null references public.products(id) on delete restrict,
  title             text,
  client_name       text not null,
  scheduled_at      timestamptz not null,
  modality          text not null check (modality in ('presencial', 'online')),
  notes             text,
  sdr_id            uuid not null references public.profiles(id) on delete restrict,
  status            text not null default 'agendada'
                      check (status in ('agendada', 'realizada', 'nao_compareceu')),
  completion_notes  text,
  completed_at      timestamptz,
  created_by        uuid not null default auth.uid() references public.profiles(id),
  created_at        timestamptz not null default now()
);

create index if not exists visits_scheduled_at_idx on public.visits (scheduled_at);
create index if not exists visits_product_idx      on public.visits (product_id);
create index if not exists visits_sdr_idx          on public.visits (sdr_id);
create index if not exists visits_status_idx       on public.visits (status);

-- ── Row Level Security ──────────────────────────────────────────────────────
alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.visits   enable row level security;

-- Perfis: qualquer usuário logado lê (para escolher o SDR responsável);
-- só admin altera perfis de outros; cada um pode editar o próprio nome.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (true);

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (public.is_admin() or (id = auth.uid() and role = (select role from public.profiles where id = auth.uid())));

-- Produtos: todos leem; só admin cria/edita.
drop policy if exists products_select on public.products;
create policy products_select on public.products
  for select to authenticated using (true);

drop policy if exists products_admin on public.products;
create policy products_admin on public.products
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Visitas: todo o time comercial vê tudo (dashboard consolidado);
-- qualquer SDR agenda; atualiza quem criou, o responsável ou admin; só admin exclui.
drop policy if exists visits_select on public.visits;
create policy visits_select on public.visits
  for select to authenticated using (true);

drop policy if exists visits_insert on public.visits;
create policy visits_insert on public.visits
  for insert to authenticated with check (created_by = auth.uid());

drop policy if exists visits_update on public.visits;
create policy visits_update on public.visits
  for update to authenticated
  using (created_by = auth.uid() or sdr_id = auth.uid() or public.is_admin());

drop policy if exists visits_delete on public.visits;
create policy visits_delete on public.visits
  for delete to authenticated using (public.is_admin());

-- ── Produtos iniciais (edite conforme o portfólio da Moon) ──────────────────
insert into public.products (name, location, color)
select * from (values
  ('Residencial Lua Nova',   'Zona Sul',    '#378ADD'),
  ('Moon Tower',             'Centro',      '#1D9E75'),
  ('Villa Crescente',        'Zona Oeste',  '#BA7517')
) as v(name, location, color)
where not exists (select 1 from public.products);
