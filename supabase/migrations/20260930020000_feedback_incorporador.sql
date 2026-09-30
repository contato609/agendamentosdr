-- ════════════════════════════════════════════════════════════════════════════
-- Feedback do incorporador pelo portal: vendeu / não comprou / devolver para
-- reagendamento. O cliente continua sem acesso direto à tabela de visitas:
-- tudo passa pela função client_feedback(), que valida o empreendimento.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.visits
  add column if not exists reschedule_requested boolean not null default false,
  add column if not exists reschedule_note      text,
  add column if not exists feedback_source      text check (feedback_source in ('equipe', 'cliente'));

-- Leitura do cliente (continua sem sdr_id e sem created_by)
drop function if exists public.client_visits();
create function public.client_visits()
returns table (
  id uuid, product_id uuid, client_name text, scheduled_at timestamptz, modality text, status text,
  notes text, completion_notes text, sale_status text, vgv numeric, sale_notes text,
  reschedule_requested boolean, reschedule_note text, feedback_source text
)
language sql stable
security definer set search_path = public
as $$
  select v.id, v.product_id, v.client_name, v.scheduled_at, v.modality, v.status,
         v.notes, v.completion_notes, v.sale_status, v.vgv, v.sale_notes,
         v.reschedule_requested, v.reschedule_note, v.feedback_source
  from public.visits v
  join public.client_products cp on cp.product_id = v.product_id and cp.client_id = auth.uid()
  join public.profiles me on me.id = auth.uid() and me.role = 'cliente' and me.active
  order by v.scheduled_at;
$$;
revoke all on function public.client_visits() from public, anon;
grant execute on function public.client_visits() to authenticated;

-- Escrita do cliente: só nas visitas dos empreendimentos liberados para ele
create or replace function public.client_feedback(p_visit uuid, p_outcome text, p_vgv numeric default null, p_note text default null)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v public.visits;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'cliente' and active) then
    raise exception 'Acesso negado.';
  end if;

  select vi.* into v
  from public.visits vi
  join public.client_products cp on cp.product_id = vi.product_id and cp.client_id = auth.uid()
  where vi.id = p_visit
  for update of vi;
  if not found then raise exception 'Visita não encontrada.'; end if;

  if p_outcome in ('vendeu', 'nao_vendeu') then
    if v.status = 'nao_compareceu' or (v.status = 'realizada' and v.sale_status is not null) then
      raise exception 'Esta visita já tem resultado registrado.';
    end if;
    if p_outcome = 'vendeu' and (p_vgv is null or p_vgv <= 0) then raise exception 'Informe o VGV da venda.'; end if;
    if p_outcome = 'nao_vendeu' and coalesce(trim(p_note), '') = '' then raise exception 'Informe por que o cliente não comprou.'; end if;
    update public.visits set
      status = 'realizada',
      completed_at = coalesce(completed_at, now()),
      completion_notes = coalesce(completion_notes, 'Comparecimento confirmado pelo incorporador.'),
      sale_status = p_outcome,
      vgv = case when p_outcome = 'vendeu' then round(p_vgv, 2) end,
      sale_notes = nullif(trim(p_note), ''),
      sale_at = now(),
      feedback_source = 'cliente',
      reschedule_requested = false
    where id = p_visit;

  elsif p_outcome = 'reagendar' then
    if v.status not in ('agendada', 'aguardando_feedback') then
      raise exception 'Só visitas ainda em aberto podem voltar para reagendamento.';
    end if;
    update public.visits set
      status = 'aguardando_feedback',
      reschedule_requested = true,
      reschedule_note = nullif(trim(p_note), ''),
      feedback_source = 'cliente'
    where id = p_visit;

  else
    raise exception 'Opção de feedback inválida.';
  end if;
end;
$$;
revoke all on function public.client_feedback(uuid, text, numeric, text) from public, anon;
grant execute on function public.client_feedback(uuid, text, numeric, text) to authenticated;

notify pgrst, 'reload schema';
