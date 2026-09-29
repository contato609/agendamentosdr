-- ════════════════════════════════════════════════════════════════════════════
-- Novo status manual: aguardando_feedback (visita aconteceu, aguardando retorno do cliente)
-- ════════════════════════════════════════════════════════════════════════════
alter table public.visits drop constraint if exists visits_status_check;
alter table public.visits add constraint visits_status_check
  check (status in ('agendada', 'aguardando_feedback', 'realizada', 'nao_compareceu'));

notify pgrst, 'reload schema';
