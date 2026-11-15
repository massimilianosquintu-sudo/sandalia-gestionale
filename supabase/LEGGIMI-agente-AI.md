# Agente AI del portale – proxy "claude-proxy"

Nel portale l'agente AI (Contabilità forfettaria, semplificata, ordinaria, Bilancio XBRL e lettura dei
PDF nel Previsionale) non usa più una chiave API salvata nel browser: passa dalla Edge Function
`Claude-proxy` del progetto Supabase
dello Studio, che custodisce la chiave nei propri secrets.

```
Modulo del portale ──token di sessione──▶ Edge Function claude-proxy ──chiave API──▶ API Anthropic
                                            │ verifica: dominio, sessione, sandalia_membro()
                                            └─▶ tabella claude_log (consumi per operatore e modulo)
```

Dentro Claude l'agente continua a usare la capacità integrata, come prima.

## Messa in opera (una tantum, prima di pubblicare queste modifiche sul sito)

1. **Nuova chiave API** – platform.claude.com → Settings → API keys → *Create key*.
   Revoca la chiave usata finora nel browser e imposta un limite di spesa mensile in *Limits*.
2. **Tabella consumi** – Supabase → SQL Editor → esegui `supabase/claude_log.sql`.
3. **Secrets** – Supabase → Edge Functions → *Secrets*:
   - `ANTHROPIC_API_KEY` = la nuova chiave `sk-ant-…`
   - `ALLOWED_ORIGINS` = `https://massimilianosquintu-sudo.github.io`
     (aggiungi, separati da virgola, eventuali altri indirizzi da cui apri il portale)
   - facoltativi: `ALLOWED_EMAILS` (filtro in più rispetto ai membri), `ALLOWED_MODELS`,
     `DEFAULT_MODEL`, `MAX_TOKENS_CAP` (predefinito 16000), `LOG_USAGE` (predefinito true)
4. **Pubblica la funzione** – Supabase → Edge Functions → *Deploy a new function* → *Via editor*,
   nome `Claude-proxy` (con la C maiuscola: è il nome usato dal portale), incolla `supabase/functions/claude-proxy/index.ts`.
   Da terminale: `supabase functions deploy claude-proxy`.
5. **Prova** – nel portale, accedi al cloud, apri un modulo → scheda dell'agente → *Prova la connessione*.

## Chi può usare l'agente

Solo chi ha effettuato l'accesso al cloud dal portale ed è iscritto in `sandalia_membri`
(stessa regola dell'archivio). Senza accesso al cloud l'agente risulta "Non collegato".

## Consumi

```sql
select * from claude_consumi_mensili;   -- richieste e token per mese, operatore e modello
```
Il campo `modulo` di `claude_log` indica da quale app è partita la richiesta
(forfettaria, semplificata, ordinaria, bilancio-xbrl, previsionale).

## Messaggi di errore nel portale

| Messaggio | Causa |
|---|---|
| Il proxy dell'agente non è ancora pubblicato | manca la funzione `claude-proxy` (passo 4) |
| Proxy non configurato | manca `ANTHROPIC_API_KEY` nei secrets |
| Sessione del cloud scaduta | rifare l'accesso dalla Scrivania |
| Agente non disponibile per questo utente | utente non membro o escluso da `ALLOWED_EMAILS` |
| Origine non autorizzata | l'indirizzo del portale non è in `ALLOWED_ORIGINS` |

## Dati dei clienti

Prima di inviare dati fiscali o personali dei clienti, verifica i Termini commerciali e il DPA
di Anthropic (GDPR) e annota il trattamento nel registro dello Studio.
