-- ════════════════════════════════════════════════════════════════════════════
-- Hierarquia: gestor (admin) vê tudo; cada SDR vê e agenda só o que é dele.
-- ════════════════════════════════════════════════════════════════════════════

-- Perfis: SDR enxerga só o próprio perfil; gestor enxerga a equipe toda.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

-- Visitas: SDR vê só as visitas em que é o responsável.
drop policy if exists visits_select on public.visits;
create policy visits_select on public.visits
  for select to authenticated
  using (sdr_id = auth.uid() or public.is_admin());

-- SDR só cria visitas atribuídas a ele mesmo; gestor atribui a qualquer SDR.
drop policy if exists visits_insert on public.visits;
create policy visits_insert on public.visits
  for insert to authenticated
  with check (created_by = auth.uid() and (sdr_id = auth.uid() or public.is_admin()));

-- SDR só altera as próprias visitas e não pode repassá-las para outro SDR.
drop policy if exists visits_update on public.visits;
create policy visits_update on public.visits
  for update to authenticated
  using (sdr_id = auth.uid() or public.is_admin())
  with check (sdr_id = auth.uid() or public.is_admin());

notify pgrst, 'reload schema';
