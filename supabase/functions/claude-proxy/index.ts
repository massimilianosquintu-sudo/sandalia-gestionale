// =====================================================================
//  Sandalia Gestionale – Proxy verso le API di Claude (Anthropic)
//  Supabase Edge Function: supabase/functions/claude-proxy/index.ts
//
//  Cosa fa:
//   1. accetta richieste solo dal dominio del portale (CORS)
//   2. accetta solo utenti autenticati su Supabase e iscritti tra i membri
//      dello Studio (funzione sandalia_membro() del portale)
//   3. limita modelli e token per contenere i costi
//   4. aggiunge la chiave API (custodita nei "secrets" di Supabase)
//      e inoltra la richiesta ad Anthropic
//   5. registra il consumo nella tabella "claude_log" (facoltativo)
//
//  La chiave API NON arriva mai nel browser.
// =====================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

// ---------- Configurazione (impostata come secrets di Supabase) ----------
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const ANTHROPIC_VERSION = Deno.env.get("ANTHROPIC_VERSION") ?? "2023-06-01";
// Versioni che il portale può chiedere con l'intestazione anthropic-version
const VERSIONI_AMMESSE = ["2023-06-01", "2026-10-21"];
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Domini da cui il portale può chiamare il proxy (separati da virgola)
// es. "https://tuonome.github.io,http://localhost:5500"
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Filtro facoltativo per email, in aggiunta al controllo dei membri (vuoto = tutti i membri)
const ALLOWED_EMAILS = (Deno.env.get("ALLOWED_EMAILS") ?? "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// Modelli consentiti e modello predefinito
const ALLOWED_MODELS = (Deno.env.get("ALLOWED_MODELS") ??
  "claude-sonnet-5-5,claude-haiku-5-5,claude-opus-5-5")
  .split(",").map((s) => s.trim()).filter(Boolean);
const DEFAULT_MODEL = Deno.env.get("DEFAULT_MODEL") ?? "claude-sonnet-5-5";

// Tetto ai token di risposta e alla dimensione della richiesta
const MAX_TOKENS_CAP = Number(Deno.env.get("MAX_TOKENS_CAP") ?? "16000");
const MAX_BODY_BYTES = Number(Deno.env.get("MAX_BODY_BYTES") ?? String(32 * 1024 * 1024)); // 32 MB (immagini e PDF allegati)

// Registrazione dei consumi nella tabella claude_log (true/false)
const LOG_USAGE = (Deno.env.get("LOG_USAGE") ?? "true") === "true";

// ---------- Utilità ----------
function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin));
  return {
    "Access-Control-Allow-Origin": allowed ? origin! : (ALLOWED_ORIGINS[0] ?? "null"),
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, anthropic-version",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function errore(status: number, messaggio: string, origin: string | null): Response {
  return new Response(JSON.stringify({ error: { type: "proxy_error", message: messaggio } }), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

// ---------- Gestore principale ----------
Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("Origin");

  // Pre-flight CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") return errore(405, "Metodo non consentito", origin);

  // 1) Controllo dell'origine
  if (ALLOWED_ORIGINS.length > 0 && (!origin || !ALLOWED_ORIGINS.includes(origin))) {
    return errore(403, "Origine non autorizzata", origin);
  }
  if (!ANTHROPIC_API_KEY) return errore(500, "Chiave API non configurata sul server", origin);

  // 2) Controllo dell'utente (sessione Supabase)
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return errore(401, "Accesso richiesto", origin);

  const supabaseUtente = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: erroreUtente } = await supabaseUtente.auth.getUser();
  if (erroreUtente || !user) return errore(401, "Sessione non valida o scaduta", origin);

  // Solo i membri dello Studio (stessa regola dell'archivio sandalia_documenti)
  const { data: membro, error: erroreMembro } = await supabaseUtente.rpc("sandalia_membro");
  if (erroreMembro) return errore(500, `Verifica dei membri non riuscita: ${erroreMembro.message}`, origin);
  if (membro !== true) return errore(403, "l'utente non è iscritto tra i membri dello Studio", origin);

  const email = (user.email ?? "").toLowerCase();
  if (ALLOWED_EMAILS.length > 0 && !ALLOWED_EMAILS.includes(email)) {
    return errore(403, "utente non abilitato all'agente AI", origin);
  }

  // 3) Lettura e verifica della richiesta
  const lunghezza = Number(req.headers.get("Content-Length") ?? "0");
  if (lunghezza > MAX_BODY_BYTES) return errore(413, "Richiesta troppo grande", origin);

  let corpo: Record<string, unknown>;
  try {
    const testo = await req.text();
    if (testo.length > MAX_BODY_BYTES) return errore(413, "Richiesta troppo grande", origin);
    corpo = JSON.parse(testo);
  } catch {
    return errore(400, "JSON non valido", origin);
  }

  if (!Array.isArray(corpo.messages) || corpo.messages.length === 0) {
    return errore(400, "Il campo 'messages' è obbligatorio", origin);
  }

  const modello = typeof corpo.model === "string" && corpo.model ? corpo.model : DEFAULT_MODEL;
  if (!ALLOWED_MODELS.includes(modello)) {
    return errore(400, `Modello non consentito: ${modello}`, origin);
  }
  const maxTokens = Math.min(Number(corpo.max_tokens) || 4000, MAX_TOKENS_CAP);
  const streaming = corpo.stream === true;

  // Si inoltrano solo i campi ammessi
  const richiestaAnthropic: Record<string, unknown> = {
    model: modello,
    max_tokens: maxTokens,
    messages: corpo.messages,
  };
  for (const campo of ["system", "temperature", "tools", "tool_choice", "stop_sequences", "stream", "metadata"]) {
    if (corpo[campo] !== undefined) richiestaAnthropic[campo] = corpo[campo];
  }
  // Identificativo anonimo dell'operatore (utile ad Anthropic per gli abusi)
  richiestaAnthropic.metadata = { user_id: user.id };

  const richiesta = req.headers.get("anthropic-version") ?? "";
  const versione = VERSIONI_AMMESSE.includes(richiesta) ? richiesta : ANTHROPIC_VERSION;

  // 4) Inoltro ad Anthropic
  let risposta: Response;
  try {
    risposta = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": versione,
        "content-type": "application/json",
      },
      body: JSON.stringify(richiestaAnthropic),
    });
  } catch (e) {
    return errore(502, `Anthropic non raggiungibile: ${(e as Error).message}`, origin);
  }

  const intestazioni = {
    ...corsHeaders(origin),
    "Content-Type": risposta.headers.get("Content-Type") ?? "application/json",
  };

  // Streaming: si passa il flusso così com'è
  if (streaming) {
    return new Response(risposta.body, { status: risposta.status, headers: intestazioni });
  }

  // 5) Risposta normale + registrazione dei consumi
  const testoRisposta = await risposta.text();
  if (LOG_USAGE && risposta.ok && SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const dati = JSON.parse(testoRisposta);
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      await admin.from("claude_log").insert({
        user_id: user.id,
        email,
        modello,
        token_input: dati?.usage?.input_tokens ?? null,
        token_output: dati?.usage?.output_tokens ?? null,
        modulo: typeof corpo.modulo === "string" ? corpo.modulo : null,
      });
    } catch (_) {
      // la registrazione non deve mai bloccare la risposta
    }
  }

  return new Response(testoRisposta, { status: risposta.status, headers: intestazioni });
});
