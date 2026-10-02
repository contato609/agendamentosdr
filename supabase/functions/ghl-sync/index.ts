// Edge Function: envia as visitas do sistema para o GoHighLevel (API v2 / LeadConnector).
// Deploy: supabase functions deploy ghl-sync
//
// Segredos (Supabase → Edge Functions → Secrets):
//   GHL_TOKEN        Private Integration Token (contatos, calendários e oportunidades)
//   GHL_LOCATION_ID  ID da subconta (location)
//   GHL_CALENDAR_ID  ID do calendário de agendamento de visita
//   GHL_PIPELINE_ID  ID do pipeline das oportunidades
//   GHL_STAGE_ID     ID da etapa "Visita agendada"
//
// Ações (body JSON):
//   { action: "sync",   visit_id }  cria/atualiza contato, agendamento e oportunidade
//   { action: "cancel", visit_id }  cancela o agendamento no GHL (antes de excluir a visita)
//   { action: "discover" }          (gestor) testa a conexão e lista calendários e pipelines
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const GHL = 'https://services.leadconnectorhq.com';
const env = (k: string) => Deno.env.get(k) ?? '';
const VISIT_MINUTES = 60;

async function ghl(path: string, init: { method?: string; body?: unknown; version?: string } = {}) {
  const res = await fetch(GHL + path, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${env('GHL_TOKEN')}`,
      Version: init.version ?? '2021-07-28',
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.message ?? data?.error ?? data?.raw ?? res.statusText;
    throw new Error(`GHL ${res.status} em ${path.split('?')[0]}: ${Array.isArray(msg) ? msg.join('; ') : msg}`);
  }
  return data;
}

// Telefone em E.164; números brasileiros sem DDI ganham +55.
function e164(phone: string | null) {
  if (!phone) return null;
  const raw = phone.trim();
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (raw.startsWith('+')) return '+' + digits;
  if (digits.length === 10 || digits.length === 11) return '+55' + digits;
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) return '+' + digits;
  return '+' + digits;
}

const statusFor = (s: string) =>
  s === 'realizada' ? 'showed' : s === 'nao_compareceu' ? 'noshow' : 'confirmed';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

  // Quem chama precisa ser da equipe (gestor ou SDR ativo).
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return json({ error: 'Não autenticado.' }, 401);
  const { data: me } = await db.from('profiles').select('id, role, active').eq('id', user.id).single();
  if (!me || me.active === false || me.role === 'cliente') return json({ error: 'Acesso negado.' }, 403);

  const { action = 'sync', visit_id } = await req.json().catch(() => ({}));
  const configured = ['GHL_TOKEN', 'GHL_LOCATION_ID', 'GHL_CALENDAR_ID'].every(k => env(k));

  // ── Testar conexão / descobrir IDs ────────────────────────────────────────
  if (action === 'discover') {
    if (me.role !== 'admin') return json({ error: 'Apenas gestores.' }, 403);
    const missing = ['GHL_TOKEN', 'GHL_LOCATION_ID', 'GHL_CALENDAR_ID', 'GHL_PIPELINE_ID', 'GHL_STAGE_ID'].filter(k => !env(k));
    if (!env('GHL_TOKEN') || !env('GHL_LOCATION_ID')) return json({ ok: false, missing });
    try {
      const loc = env('GHL_LOCATION_ID');
      const cal = await ghl(`/calendars/?locationId=${loc}`, { version: '2021-04-15' });
      const pip = await ghl(`/opportunities/pipelines?locationId=${loc}`);
      return json({
        ok: true, missing,
        configured: { calendar: env('GHL_CALENDAR_ID'), pipeline: env('GHL_PIPELINE_ID'), stage: env('GHL_STAGE_ID') },
        calendars: (cal?.calendars ?? []).map((c: any) => ({ id: c.id, name: c.name })),
        pipelines: (pip?.pipelines ?? []).map((p: any) => ({ id: p.id, name: p.name, stages: (p.stages ?? []).map((s: any) => ({ id: s.id, name: s.name })) })),
      });
    } catch (e) {
      return json({ ok: false, missing, error: (e as Error).message });
    }
  }

  if (!visit_id) return json({ error: 'Informe a visita.' }, 400);
  const { data: v } = await db.from('visits').select('*').eq('id', visit_id).single();
  if (!v) return json({ error: 'Visita não encontrada.' }, 404);
  if (me.role !== 'admin' && v.sdr_id !== me.id) return json({ error: 'Acesso negado.' }, 403);

  if (!configured) {
    await db.from('visits').update({ ghl_sync_status: 'desativado', ghl_sync_error: null }).eq('id', visit_id);
    return json({ skipped: 'not_configured' });
  }

  const save = (patch: Record<string, unknown>) => db.from('visits').update({ ...patch, ghl_synced_at: new Date().toISOString() }).eq('id', visit_id);

  try {
    // ── Cancelar (antes de excluir a visita no sistema) ─────────────────────
    if (action === 'cancel') {
      if (v.ghl_appointment_id) {
        await ghl(`/calendars/events/appointments/${v.ghl_appointment_id}`, {
          method: 'PUT', version: '2021-04-15', body: { appointmentStatus: 'cancelled' },
        });
      }
      return json({ ok: true });
    }

    const loc = env('GHL_LOCATION_ID');
    const { data: product } = await db.from('products').select('name').eq('id', v.product_id).single();
    const { data: sdr } = await db.from('profiles').select('full_name').eq('id', v.sdr_id).single();
    const productName = product?.name ?? 'Empreendimento';
    const phone = e164(v.lead_phone);
    if (!phone && !v.lead_email) throw new Error('A visita não tem telefone nem e-mail do lead.');

    // 1. Contato (cria ou atualiza pelo telefone/e-mail)
    let contactId = v.ghl_contact_id;
    const up = await ghl('/contacts/upsert', {
      method: 'POST',
      body: {
        locationId: loc, name: v.client_name, phone: phone ?? undefined, email: v.lead_email || undefined,
        source: 'Sistema de Visitas Garantidas', tags: ['visita-agendada', productName],
      },
    });
    contactId = up?.contact?.id ?? contactId;
    if (!contactId) throw new Error('O GHL não devolveu o ID do contato.');

    // 2. Agendamento (1 hora) no calendário de visitas
    const start = new Date(v.scheduled_at);
    const end = new Date(start.getTime() + VISIT_MINUTES * 60000);
    const title = `Visita ${productName} — ${v.client_name}`;
    const isOpen = v.status === 'agendada' || v.status === 'aguardando_feedback';
    let appointmentId = v.ghl_appointment_id;
    const firstSync = !appointmentId;
    if (appointmentId) {
      await ghl(`/calendars/events/appointments/${appointmentId}`, {
        method: 'PUT', version: '2021-04-15',
        body: { title, startTime: start.toISOString(), endTime: end.toISOString(), appointmentStatus: statusFor(v.status), ignoreFreeSlotValidation: true },
      });
    } else {
      const ap = await ghl('/calendars/events/appointments', {
        method: 'POST', version: '2021-04-15',
        body: {
          calendarId: env('GHL_CALENDAR_ID'), locationId: loc, contactId, title,
          startTime: start.toISOString(), endTime: end.toISOString(),
          appointmentStatus: statusFor(v.status), ignoreFreeSlotValidation: true, toNotify: true,
        },
      });
      appointmentId = ap?.id ?? ap?.appointment?.id ?? ap?.event?.id;
      if (!appointmentId) throw new Error('O GHL não devolveu o ID do agendamento.');

      // Nota no contato com os detalhes da visita (uma vez, na criação)
      const lines = [
        `Visita agendada pelo Sistema de Visitas Garantidas`,
        `Empreendimento: ${productName}`,
        `Data: ${start.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`,
        `Modalidade: ${v.modality === 'presencial' ? 'Presencial' : 'Online'}`,
        `SDR: ${sdr?.full_name ?? '—'}`,
        v.notes ? `Observação: ${v.notes}` : '',
      ].filter(Boolean).join('\n');
      await ghl(`/contacts/${contactId}/notes`, { method: 'POST', body: { body: lines } }).catch(() => null);
    }

    // 3. Oportunidade → etapa "Visita agendada" (na criação e ao reagendar visita em aberto)
    let opportunityId = v.ghl_opportunity_id;
    const pipelineId = env('GHL_PIPELINE_ID'), stageId = env('GHL_STAGE_ID');
    if (pipelineId && stageId && isOpen && (firstSync || !opportunityId)) {
      if (!opportunityId) {
        const found = await ghl(`/opportunities/search?location_id=${loc}&contact_id=${contactId}&pipeline_id=${pipelineId}`);
        opportunityId = found?.opportunities?.[0]?.id ?? null;
      }
      if (opportunityId) {
        await ghl(`/opportunities/${opportunityId}`, { method: 'PUT', body: { pipelineStageId: stageId, status: 'open' } });
      } else {
        const op = await ghl('/opportunities/', {
          method: 'POST',
          body: { locationId: loc, pipelineId, pipelineStageId: stageId, status: 'open', contactId, name: `${v.client_name} — ${productName}` },
        });
        opportunityId = op?.opportunity?.id ?? op?.id ?? null;
      }
    }

    await save({ ghl_contact_id: contactId, ghl_appointment_id: appointmentId, ghl_opportunity_id: opportunityId, ghl_sync_status: 'ok', ghl_sync_error: null });
    return json({ ok: true, contactId, appointmentId, opportunityId });
  } catch (e) {
    const msg = (e as Error).message;
    if (action !== 'cancel') await save({ ghl_sync_status: 'erro', ghl_sync_error: msg.slice(0, 500) });
    return json({ error: msg }, 502);
  }
});
