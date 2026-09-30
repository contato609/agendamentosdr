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
