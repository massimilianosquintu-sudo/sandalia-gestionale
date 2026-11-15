-- =====================================================================
--  Sandalia Gestionale – Registro dei consumi di Claude
--  Da eseguire una volta in Supabase → SQL Editor
-- =====================================================================

create table if not exists public.claude_log (
  id            bigint generated always as identity primary key,
  creato_il     timestamptz not null default now(),
  user_id       uuid references auth.users(id) on delete set null,
  email         text,
  modello       text,
  token_input   integer,
  token_output  integer,
  modulo        text          -- es. 'contabilita-forfettaria', 'redditi-pf'
);

-- Nessun accesso dal browser: scrive solo la Edge Function (service role)
alter table public.claude_log enable row level security;

-- Ogni operatore può leggere solo i propri consumi
create policy "lettura propri consumi"
  on public.claude_log for select
  to authenticated
  using (auth.uid() = user_id);

-- Riepilogo mensile per operatore e modello
create or replace view public.claude_consumi_mensili
with (security_invoker = true) as
select
  date_trunc('month', creato_il)::date as mese,
  email,
  modello,
  count(*)                as richieste,
  sum(token_input)        as token_input,
  sum(token_output)       as token_output
from public.claude_log
group by 1, 2, 3
order by 1 desc, 2, 3;
