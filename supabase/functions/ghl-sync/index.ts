// Edge Function: envia as visitas do sistema para o GoHighLevel (API v2 / LeadConnector).
// Deploy: supabase functions deploy ghl-sync
//
// Cada empreendimento aponta para a SUA subconta do GHL (tabela ghl_connections):
// location, token da integração privada, calendário, pipeline e etapa "Visita agendada".
// A tabela não é legível pelo navegador; só esta função (service role) lê o token.
//
// Ações (body JSON):
//   { action: "sync",   visit_id }    cria/atualiza contato, agendamento e oportunidade
//   { action: "cancel", visit_id }    cancela o agendamento no GHL (antes de excluir a visita)
//   { action: "discover", product_id } (gestor) testa a subconta e lista calendários e pipelines
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

type Conn = { location_id: string; token: string; calendar_id: string | null; pipeline_id: string | null; stage_id: string | null };

async function ghl(conn: Conn, path: string, init: { method?: string; body?: unknown; version?: string } = {}) {
  const res = await fetch(GHL + path, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${conn.token}`,
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

  const { action = 'sync', visit_id, product_id } = await req.json().catch(() => ({}));
  const connFor = async (pid: string): Promise<Conn | null> =>
    (await db.from('ghl_connections').select('location_id, token, calendar_id, pipeline_id, stage_id').eq('product_id', pid).maybeSingle()).data as Conn | null;

  // ── Testar a subconta de um empreendimento / descobrir IDs ────────────────
  if (action === 'discover') {
    if (me.role !== 'admin') return json({ error: 'Apenas gestores.' }, 403);
    if (!product_id) return json({ error: 'Informe o empreendimento.' }, 400);
    const c = await connFor(product_id);
    if (!c) return json({ ok: false, error: 'Este empreendimento ainda não tem subconta do GHL configurada.' });
    try {
      const cal = await ghl(c, `/calendars/?locationId=${c.location_id}`, { version: '2021-04-15' });
      const pip = await ghl(c, `/opportunities/pipelines?locationId=${c.location_id}`);
      return json({
        ok: true,
        configured: { calendar: c.calendar_id, pipeline: c.pipeline_id, stage: c.stage_id },
        calendars: (cal?.calendars ?? []).map((x: any) => ({ id: x.id, name: x.name })),
        pipelines: (pip?.pipelines ?? []).map((p: any) => ({ id: p.id, name: p.name, stages: (p.stages ?? []).map((s: any) => ({ id: s.id, name: s.name })) })),
      });
    } catch (e) {
      return json({ ok: false, error: (e as Error).message });
    }
  }

  if (!visit_id) return json({ error: 'Informe a visita.' }, 400);
  const { data: v } = await db.from('visits').select('*').eq('id', visit_id).single();
  if (!v) return json({ error: 'Visita não encontrada.' }, 404);
  if (me.role !== 'admin' && v.sdr_id !== me.id) return json({ error: 'Acesso negado.' }, 403);

  // A subconta vem do empreendimento da visita
  const conn = await connFor(v.product_id);
  if (!conn || !conn.calendar_id) {
    await db.from('visits').update({ ghl_sync_status: 'desativado', ghl_sync_error: null }).eq('id', visit_id);
    return json({ skipped: 'not_configured' });
  }

  const save = (patch: Record<string, unknown>) => db.from('visits').update({ ...patch, ghl_synced_at: new Date().toISOString() }).eq('id', visit_id);

  try {
    // ── Cancelar (antes de excluir a visita no sistema) ─────────────────────
    if (action === 'cancel') {
      if (v.ghl_appointment_id) {
        await ghl(conn, `/calendars/events/appointments/${v.ghl_appointment_id}`, {
          method: 'PUT', version: '2021-04-15', body: { appointmentStatus: 'cancelled' },
        });
      }
      return json({ ok: true });
    }

    const loc = conn.location_id;
    const { data: product } = await db.from('products').select('name').eq('id', v.product_id).single();
    const { data: sdr } = await db.from('profiles').select('full_name').eq('id', v.sdr_id).single();
    const productName = product?.name ?? 'Empreendimento';
    const phone = e164(v.lead_phone);
    if (!phone && !v.lead_email) throw new Error('A visita não tem telefone nem e-mail do lead.');

    // 1. Contato (cria ou atualiza pelo telefone/e-mail)
    let contactId = v.ghl_contact_id;
    const up = await ghl(conn, '/contacts/upsert', {
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
      await ghl(conn, `/calendars/events/appointments/${appointmentId}`, {
        method: 'PUT', version: '2021-04-15',
        body: { title, startTime: start.toISOString(), endTime: end.toISOString(), appointmentStatus: statusFor(v.status), ignoreFreeSlotValidation: true },
      });
    } else {
      const ap = await ghl(conn, '/calendars/events/appointments', {
        method: 'POST', version: '2021-04-15',
        body: {
          calendarId: conn.calendar_id, locationId: loc, contactId, title,
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
      await ghl(conn, `/contacts/${contactId}/notes`, { method: 'POST', body: { body: lines } }).catch(() => null);
    }

    // 3. Oportunidade → etapa "Visita agendada" (na criação e ao reagendar visita em aberto)
    let opportunityId = v.ghl_opportunity_id;
    const pipelineId = conn.pipeline_id, stageId = conn.stage_id;
    if (pipelineId && stageId && isOpen && (firstSync || !opportunityId)) {
      if (!opportunityId) {
        const found = await ghl(conn, `/opportunities/search?location_id=${loc}&contact_id=${contactId}&pipeline_id=${pipelineId}`);
        opportunityId = found?.opportunities?.[0]?.id ?? null;
      }
      if (opportunityId) {
        await ghl(conn, `/opportunities/${opportunityId}`, { method: 'PUT', body: { pipelineStageId: stageId, status: 'open' } });
      } else {
        const op = await ghl(conn, '/opportunities/', {
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
