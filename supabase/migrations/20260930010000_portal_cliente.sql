-- ════════════════════════════════════════════════════════════════════════════
-- Portal do Cliente: o responsável pelo empreendimento acompanha as visitas
-- dos produtos liberados para ele, sem nunca ver qual SDR agendou/atendeu.
-- ════════════════════════════════════════════════════════════════════════════

-- Novo papel "cliente" e empresa (incorporadora) no perfil
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('sdr', 'admin', 'cliente'));
alter table public.profiles add column if not exists company text;

-- Perfil criado no Auth já nasce com papel e empresa (quando informados)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, role, company)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.email,
    case new.raw_app_meta_data->>'role' when 'admin' then 'admin' when 'cliente' then 'cliente' else 'sdr' end,
    new.raw_user_meta_data->>'company'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace function public.is_client()
returns boolean
language sql stable
security definer set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'cliente');
$$;

-- Quais empreendimentos cada cliente enxerga
create table if not exists public.client_products (
  client_id  uuid not null references public.profiles(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  primary key (client_id, product_id)
);
alter table public.client_products enable row level security;

drop policy if exists client_products_select on public.client_products;
create policy client_products_select on public.client_products
  for select to authenticated using (client_id = auth.uid() or public.is_admin());

drop policy if exists client_products_admin on public.client_products;
create policy client_products_admin on public.client_products
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Produtos: cliente vê só os liberados para ele; equipe continua vendo todos
drop policy if exists products_select on public.products;
create policy products_select on public.products
  for select to authenticated
  using (
    not public.is_client()
    or exists (select 1 from public.client_products cp where cp.client_id = auth.uid() and cp.product_id = products.id)
  );

-- Cliente nunca cria visitas (a tabela de visitas continua fechada para ele)
drop policy if exists visits_insert on public.visits;
create policy visits_insert on public.visits
  for insert to authenticated
  with check (created_by = auth.uid() and not public.is_client() and (sdr_id = auth.uid() or public.is_admin()));

-- Leitura do cliente: só as colunas liberadas — sem sdr_id e sem created_by
create or replace function public.client_visits()
returns table (
  id uuid, product_id uuid, client_name text, scheduled_at timestamptz, modality text, status text,
  notes text, completion_notes text, sale_status text, vgv numeric, sale_notes text
)
language sql stable
security definer set search_path = public
as $$
  select v.id, v.product_id, v.client_name, v.scheduled_at, v.modality, v.status,
         v.notes, v.completion_notes, v.sale_status, v.vgv, v.sale_notes
  from public.visits v
  join public.client_products cp on cp.product_id = v.product_id and cp.client_id = auth.uid()
  join public.profiles me on me.id = auth.uid() and me.role = 'cliente' and me.active
  order by v.scheduled_at;
$$;
revoke all on function public.client_visits() from public, anon;
grant execute on function public.client_visits() to authenticated;

notify pgrst, 'reload schema';
