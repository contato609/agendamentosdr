// Edge Function: cria o login de um SDR, gestor ou cliente (somente gestores/admin podem chamar).
// Deploy: supabase functions deploy create-sdr
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
  if (caller?.role !== 'admin' || caller?.active === false) return json({ error: 'Apenas gestores podem criar acessos.' }, 403);

  const { full_name, email, password, role, company } = await req.json().catch(() => ({}));
  if (!full_name || !email || !password) return json({ error: 'Nome, e-mail e senha são obrigatórios.' }, 400);
  if (String(password).length < 8) return json({ error: 'A senha precisa de pelo menos 8 caracteres.' }, 400);

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name, company: company ?? null },
    app_metadata: { role: role === 'admin' ? 'admin' : role === 'cliente' ? 'cliente' : 'sdr' },
  });
  if (error) return json({ error: /already/i.test(error.message) ? 'E-mail já cadastrado.' : error.message }, 400);

  return json({ id: data.user.id, email: data.user.email });
});
