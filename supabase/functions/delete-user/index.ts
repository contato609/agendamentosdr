// Edge Function: apaga o login de um SDR, gestor ou cliente (somente gestores/admin podem chamar).
// As visitas do SDR apagado passam para outro membro da equipe (transfer_to), para não perder histórico.
// Deploy: supabase functions deploy delete-user
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // Quem está chamando precisa ser admin ativo.
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
  const { data: { user }, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !user) return json({ error: 'Não autenticado.' }, 401);
  const { data: caller } = await admin.from('profiles').select('role, active').eq('id', user.id).single();
  if (caller?.role !== 'admin' || caller?.active === false) return json({ error: 'Apenas gestores podem apagar acessos.' }, 403);

  const { user_id, transfer_to } = await req.json().catch(() => ({}));
  if (!user_id) return json({ error: 'Informe o acesso a apagar.' }, 400);
  if (user_id === user.id) return json({ error: 'Você não pode apagar o seu próprio acesso.' }, 400);

  const { data: target } = await admin.from('profiles').select('id, role').eq('id', user_id).single();
  if (!target) return json({ error: 'Acesso não encontrado.' }, 404);

  // Visitas ligadas ao usuário (como responsável ou como quem criou)
  const { count: owned } = await admin.from('visits').select('id', { count: 'exact', head: true }).eq('sdr_id', user_id);
  const { count: created } = await admin.from('visits').select('id', { count: 'exact', head: true }).eq('created_by', user_id);
  if ((owned ?? 0) + (created ?? 0) > 0) {
    if (!transfer_to) return json({ error: 'Este usuário tem visitas. Escolha para quem transferi-las.' }, 400);
    if (transfer_to === user_id) return json({ error: 'Escolha outra pessoa para receber as visitas.' }, 400);
    const { data: heir } = await admin.from('profiles').select('id, role, active').eq('id', transfer_to).single();
    if (!heir || heir.role === 'cliente') return json({ error: 'Quem recebe as visitas precisa ser da equipe.' }, 400);
    const a = await admin.from('visits').update({ sdr_id: transfer_to }).eq('sdr_id', user_id);
    if (a.error) return json({ error: a.error.message }, 400);
    const b = await admin.from('visits').update({ created_by: transfer_to }).eq('created_by', user_id);
    if (b.error) return json({ error: b.error.message }, 400);
  }

  // Apagar o login remove o perfil e os vínculos de cliente (on delete cascade).
  const { error } = await admin.auth.admin.deleteUser(user_id);
  if (error) return json({ error: error.message }, 400);
  return json({ ok: true });
});
