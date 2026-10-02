-- ════════════════════════════════════════════════════════════════════════════
-- Integração Sistema → GoHighLevel: contato do lead + IDs de sincronização
-- ════════════════════════════════════════════════════════════════════════════

alter table public.visits
  add column if not exists lead_phone         text,
  add column if not exists lead_email         text,
  add column if not exists ghl_contact_id     text,
  add column if not exists ghl_appointment_id text,
  add column if not exists ghl_opportunity_id text,
  add column if not exists ghl_sync_status    text check (ghl_sync_status in ('ok', 'erro', 'desativado')),
  add column if not exists ghl_sync_error     text,
  add column if not exists ghl_synced_at      timestamptz;

notify pgrst, 'reload schema';
