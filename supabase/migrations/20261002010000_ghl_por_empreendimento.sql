-- ════════════════════════════════════════════════════════════════════════════
-- GoHighLevel por empreendimento: cada produto aponta para a sua subconta
-- (location), com token, calendário, pipeline e etapa próprios.
-- O token nunca volta para o navegador: só a Edge Function (service role) lê.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.ghl_connections (
  product_id   uuid primary key references public.products(id) on delete cascade,
  location_id  text not null,
  token        text not null,
  calendar_id  text,
  pipeline_id  text,
  stage_id     text,
  updated_at   timestamptz not null default now()
);
alter table public.ghl_connections enable row level security;
-- Sem nenhuma policy: nem gestor nem SDR leem/escrevem direto. Tudo passa pelas funções abaixo.

-- Gestor salva/atualiza a conexão. Token em branco = mantém o atual.
create or replace function public.set_ghl_connection(
  p_product uuid, p_location text, p_token text default null,
  p_calendar text default null, p_pipeline text default null, p_stage text default null
) returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Apenas gestores.'; end if;
  if coalesce(trim(p_location), '') = '' then raise exception 'Informe o ID da subconta (location).'; end if;

  if exists (select 1 from public.ghl_connections where product_id = p_product) then
    update public.ghl_connections set
      location_id = trim(p_location),
      token       = coalesce(nullif(trim(p_token), ''), token),
      calendar_id = nullif(trim(p_calendar), ''),
      pipeline_id = nullif(trim(p_pipeline), ''),
      stage_id    = nullif(trim(p_stage), ''),
      updated_at  = now()
    where product_id = p_product;
  else
    if coalesce(trim(p_token), '') = '' then raise exception 'Informe o token da subconta.'; end if;
    insert into public.ghl_connections (product_id, location_id, token, calendar_id, pipeline_id, stage_id)
    values (p_product, trim(p_location), trim(p_token), nullif(trim(p_calendar), ''), nullif(trim(p_pipeline), ''), nullif(trim(p_stage), ''));
  end if;
end;
$$;

create or replace function public.remove_ghl_connection(p_product uuid) returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Apenas gestores.'; end if;
  delete from public.ghl_connections where product_id = p_product;
end;
$$;

-- Situação das conexões, sem o token
create or replace function public.ghl_connection_status()
returns table (product_id uuid, location_id text, calendar_id text, pipeline_id text, stage_id text, has_token boolean, updated_at timestamptz)
language sql stable
security definer set search_path = public
as $$
  select c.product_id, c.location_id, c.calendar_id, c.pipeline_id, c.stage_id, c.token <> '', c.updated_at
  from public.ghl_connections c
  where public.is_admin();
$$;

revoke all on function public.set_ghl_connection(uuid, text, text, text, text, text) from public, anon;
revoke all on function public.remove_ghl_connection(uuid) from public, anon;
revoke all on function public.ghl_connection_status() from public, anon;
grant execute on function public.set_ghl_connection(uuid, text, text, text, text, text) to authenticated;
grant execute on function public.remove_ghl_connection(uuid) to authenticated;
grant execute on function public.ghl_connection_status() to authenticated;

notify pgrst, 'reload schema';
