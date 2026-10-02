# Visitas Garantidas — Digital Moon

Sistema de agendamento e acompanhamento de visitas aos empreendimentos, com login por SDR.
Endereço: **https://agendamentosdr.sistemadevisitas.com/** (GitHub Pages).
A interface é o `index.html` (página única, sem build), com o Supabase como backend.

## Fluxo

| Aba | O que faz |
|---|---|
| **Login** | O SDR entra com e-mail e senha (Supabase Auth). Tem "Esqueci minha senha". Acesso desativado não entra. |
| **Produtos** | Cards dos empreendimentos. Ao escolher um, abre o calendário do mês. Clique no dia → formulário: nome do evento, nome do cliente, data, horário, presencial/online, SDR responsável e observação. |
| **Visitas agendadas** | Data, cliente, produto, modalidade e SDR. Botões **✓ Realizada** (pede a observação da visita) e **Não compareceu**. Visitas com data vencida aparecem como "aguardando baixa". |
| **Visitas realizadas** | Data, cliente e observação (mais produto e SDR). Filtro para ver também quem não compareceu. "Desfazer" devolve para agendadas. |
| **Dashboard** | Total agendadas, comparecidas, taxa de show up, agendadas presenciais; gráfico semanal; tabelas por produto e por SDR; próximas presenciais. Filtros: produto, SDR responsável e período. |
| **Administração** | (só gestor) Cadastrar/editar produtos e criar/desativar acessos dos SDRs. |

**Taxa de show up** = comparecidas ÷ (comparecidas + não compareceram). Visitas ainda futuras não entram
na conta, para a taxa não cair só porque a visita ainda não aconteceu.

## Setup (uma vez)

0. **Publicação** — no GitHub, Settings → Pages → *Build and deployment*: Source **Deploy from a branch**,
   branch **main**, pasta **/ (root)** → Save. Em 1–2 minutos o site fica no endereço acima.
1. **Banco** — no Supabase (projeto `dtkoiiuhsjaxaalulkwz`), SQL Editor → rode
   `supabase/migrations/20260929000000_visitas_garantidas.sql`
   (ou `supabase db push`). Cria `profiles`, `products`, `visits`, o gatilho que cria o perfil ao criar
   um usuário, as políticas RLS e 3 produtos de exemplo (edite os nomes).
   Depois rode também `supabase/migrations/20260929020000_resultado_venda.sql`
   (colunas de venda: vendeu/não vendeu, VGV e motivo).
2. **Criação de logins** — publique a Edge Function: `supabase functions deploy create-sdr`.
   Ela usa a service role no servidor e só aceita chamadas de gestores.
3. **Primeiro gestor** — em Authentication → Users → *Add user* crie o seu usuário (marque *Auto confirm*),
   depois rode:
   ```sql
   update public.profiles set role = 'admin', full_name = 'Seu Nome' where email = 'seu@email.com';
   ```
   A partir daí, os acessos dos SDRs são criados pela aba **Administração**.
4. **Segurança** — em Authentication → Sign In / Providers, desative *Allow new users to sign up*,
   para que só o gestor crie contas. Em URL Configuration, cadastre a URL onde o `index.html`
   ficará publicado (necessário para o link de redefinição de senha).

## Permissões (RLS)

- Todos os usuários logados veem produtos, equipe e visitas (o dashboard é do time).
- Qualquer SDR agenda visitas; edita/dá baixa quem criou, o SDR responsável ou o gestor.
- Só gestor cria/edita produtos, altera perfis de terceiros e exclui visitas.

## Modo demonstração

Abra https://agendamentosdr.sistemadevisitas.com/?demo para usar sem backend (dados de exemplo salvos no navegador, qualquer e-mail/senha).
Útil para treinar a equipe antes de ligar o banco.

## Resultado comercial

- **Aguardando feedback**: toda visita agendada cuja data já passou aparece nessa sub-aba até alguém marcar
  *Compareceu* ou *Não compareceu*. Também dá para mandar manualmente pelo botão **Aguardando feedback**
  (requer `supabase/migrations/20260929030000_aguardando_feedback.sql`).
- **Visitas realizadas** tem as sub-abas *Compareceu*, *Não compareceu*, *Vendeu* e *Não vendeu*.
  Em *Compareceu*, os botões **Vendeu** (pede o VGV em R$) e **Não vendeu** (pede o motivo).
- **Taxa de conversão** = vendas ÷ visitas comparecidas. **VGV vendido** soma o VGV das vendas do período.

## Hierarquia de acesso

- **Gestor (admin)**: vê e gerencia todas as visitas, produtos e a equipe; agenda para qualquer SDR.
- **SDR**: vê só as visitas em que é o responsável, e todo agendamento que cria fica atribuído a ele.
  Um SDR não vê as visitas nem os números dos outros SDRs.
- A regra fica nas políticas do banco (`supabase/migrations/20260930000000_hierarquia_sdr.sql`),
  então vale mesmo para quem tentar acessar os dados fora da tela.

## Portal do Cliente (Portal do Incorporador)

- O responsável pelo empreendimento entra **no mesmo site**; o sistema reconhece o papel `cliente` e abre o portal.
- Vê só os empreendimentos liberados para ele: visão geral (agendadas, compareceram, show up, vendas, VGV, funil),
  agenda do mês e visitas realizadas com nome completo do lead e observações.
- **Nunca vê qual SDR agendou ou atendeu**: o portal lê a função `client_visits()`, que devolve as visitas sem
  `sdr_id` e sem `created_by`; a tabela de visitas continua fechada para o cliente.
- O gestor cria e edita esses acessos em **Administração → Clientes**.
- Requer `supabase/migrations/20260930010000_portal_cliente.sql`.

### Feedback do incorporador

- No portal, a aba **Visitas agendadas** lista as visitas em aberto do empreendimento com três ações:
  **Vendeu** (pede o VGV), **Não comprou** (pede o motivo) e **Devolver p/ reagendar** (recado opcional).
- Vendeu/Não comprou transformam a visita em comparecida com o resultado; na equipe aparece "via incorporador".
- Devolver marca a visita com "reagendar · pedido do incorporador" em *Aguardando feedback* para o SDR responsável;
  ao reagendar (botão **Reagendar** → nova data), ela volta para *Agendadas*.
- O cliente grava pela função `client_feedback()`, que confere se a visita é de um empreendimento liberado.
  Requer `supabase/migrations/20260930020000_feedback_incorporador.sql`.

## Exclusões (gestor)

- **Visita**: botão *Excluir* em Visitas agendadas.
- **Produto**: *Excluir* no card do produto ou em Administração.
- **Usuário da equipe / cliente do portal**: *Excluir* em Administração. As visitas de um SDR apagado passam para
  quem o gestor escolher. Requer a Edge Function `supabase/functions/delete-user` publicada.
- Visita **vendida** sai de *Compareceu* e fica só em *Vendeu* (equipe) e em *Vendas* (portal do incorporador).

## Negociação (mesa)

Fluxo: **visita agendada → visita realizada → negociação → venda/não venda** (ou volta para reagendar).

- **Equipe**: em *Visitas realizadas → Compareceu*, o botão **Negociação** leva o lead para a nova aba **Negociação**
  (antes do Dashboard). Lá: **Vendeu**, **Não vendeu** ou **Devolver p/ reagendar**.
- **Portal do incorporador**: botão **Negociação** em *Visitas agendadas* e *Visitas realizadas*; nova aba **Negociação**
  com Vendeu / Não comprou / Devolver p/ reagendar.
- **Dashboard**: *Em negociação agora*, *Foram para a mesa* (% das comparecidas) e *Conversão da mesa*; coluna
  *Mesa* nas tabelas por produto e por SDR. No portal: card *Foram para a mesa* e etapa no funil.
- `negotiated` guarda que o lead passou pela mesa, mesmo se ele voltar para reagendar.
- Requer `supabase/migrations/20261001000000_negociacao.sql`.

## Integração GoHighLevel (Sistema → GHL)

Ao agendar no sistema, a função `ghl-sync`:
1. cria/atualiza o **contato** do lead (telefone em E.164, e-mail, tags `visita-agendada` + produto) e grava uma nota com os detalhes;
2. cria o **agendamento** de 1 hora no calendário de visitas (status confirmado);
3. move/cria a **oportunidade** na etapa *Visita agendada*.

Depois: reagendar move o mesmo agendamento; compareceu/não compareceu viram `showed`/`noshow`; excluir cancela.
O corretor é atribuído pela automação do GHL (gatilho de agendamento → *Assign user* + notificação).
Falhas não perdem a visita: aparece "não enviada ao GHL" e o botão **Reenviar ao GHL**.

Setup:
1. Rode `supabase/migrations/20261002000000_integracao_ghl.sql`.
2. Publique a Edge Function `supabase/functions/ghl-sync` (nome `ghl-sync`).
3. Em Edge Functions → Secrets: `GHL_TOKEN`, `GHL_LOCATION_ID`, `GHL_CALENDAR_ID`, `GHL_PIPELINE_ID`, `GHL_STAGE_ID`.
   Em Administração → Integração GoHighLevel → *Testar conexão* aparecem os IDs de calendários, pipelines e etapas.
