#!/usr/bin/env node
// ============================================================
// alerta-saldo.mjs — Reposição automatizada (coleta + alerta Telegram)
//
// Roda SEM sessão Claude (node puro, sem deps). Pensado pra crontab na VPS:
//   0 */3 * * *  cd /var/www/dashboard-trafego && node --env-file=.env alerta-saldo.mjs >> logs/alerta-saldo.log 2>&1
//
// O que faz:
//   1. GET /api/saldo (mesmo serviço, localhost:3030) → saldo real das contas.
//   2. Para contas PRÉ-PAGAS, avalia o saldo disponível (Meta display_string).
//   3. Se zerou (<= R$0,50) ou caiu abaixo do limite, manda alerta no Telegram.
//   4. Anti-spam: 1 alerta/dia por cliente por nível (escala baixo→zerado re-alerta).
//
// Cartão (Suprema) NÃO entra — não tem saldo a zerar (cobra no cartão).
//
// ENV (no .env do serviço):
//   TELEGRAM_BOT_TOKEN   (obrigatório)  token do @Fenicebot_bot
//   ALERTA_CHAT_ID       (obrigatório)  chat/grupo interno que recebe o alerta
//   ALERTA_LIMITE_REAIS  (opcional, default 50)   limite de "saldo baixo" em R$
//   SALDO_URL            (opcional, default http://127.0.0.1:3030/api/saldo)
//   ALERTA_STATE_FILE    (opcional, default ./data/alerta-saldo-state.json)
//   ALERTA_GASTO_DIA_JSON(opcional)  ex: {"arena":36.68,"oca":40} → mostra cobertura em dias
//   DRY_RUN=1            (opcional)  não envia; só imprime o que enviaria
// ============================================================
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const SALDO_URL = process.env.SALDO_URL || 'http://127.0.0.1:3030/api/saldo';
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.ALERTA_CHAT_ID || '';
const LIMITE_CENTS = Math.round(Number(process.env.ALERTA_LIMITE_REAIS || 50) * 100);
const STATE_FILE = resolve(HERE, process.env.ALERTA_STATE_FILE || './data/alerta-saldo-state.json');
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const ZERO_CENTS = 50; // <= R$0,50 conta como zerado

// Só alerta clientes Fenice (o /api/saldo devolve todas as contas do token,
// incluindo Starken/Madrugão — que são operação separada). Override via ALERTA_SLUGS.
const ALLOW = new Set(
  (process.env.ALERTA_SLUGS || 'suprema,arena,oca,cotafacil,imperio')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const DIAS_ALVO = Number(process.env.ALERTA_DIAS_ALVO || 15); // sugestão de quanto repor cobre N dias

let GASTO_DIA = {};
try { GASTO_DIA = JSON.parse(process.env.ALERTA_GASTO_DIA_JSON || '{}'); } catch { GASTO_DIA = {}; }

// Link direto pra tela de Faturamento da conta certa (1 toque → "Adicionar dinheiro" → PIX).
// A Meta NÃO expõe o código PIX por API — isto leva o Juan direto pra tela onde ele gera.
const billingUrl = (adAccountId) =>
  `https://adsmanager.facebook.com/ads/manager/account_settings/account_billing/?act=${String(adAccountId || '').replace(/^act_/, '')}`;

const brl = (cents) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const hoje = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}
async function saveState(state) {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function fetchSaldo() {
  const r = await fetch(SALDO_URL, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`GET ${SALDO_URL} → HTTP ${r.status}`);
  const d = await r.json();
  return (d.clients ?? []);
}

// nível de cada cliente pré-pago a partir do disponível
function avaliar(clients) {
  const out = [];
  for (const c of clients) {
    if (ALLOW.size && !ALLOW.has(c.slug)) continue;    // só clientes Fenice
    if (c.funding_tipo !== 'prepago') continue;       // cartão/outros não têm saldo a zerar
    if (c.disponivel_cents == null) continue;          // sem dado → ignora (não falso-alarme)
    const cents = c.disponivel_cents;
    let nivel = 'ok';
    if (cents <= ZERO_CENTS) nivel = 'zerado';
    else if (cents <= LIMITE_CENTS) nivel = 'baixo';
    const gastoDia = GASTO_DIA[c.slug];
    const dias = gastoDia ? cents / 100 / gastoDia : null;
    // sugestão de reposição: cobrir DIAS_ALVO dias, descontando o saldo atual, arredondado p/ R$10
    const sugestao = gastoDia ? Math.max(0, Math.ceil((gastoDia * DIAS_ALVO - cents / 100) / 10) * 10) : null;
    out.push({ slug: c.slug, nome: c.name || c.slug, cents, nivel, dias, sugestao, aid: c.ad_account_id });
  }
  return out;
}

function linha(c) {
  const emoji = c.nivel === 'zerado' ? '🔴' : '🟡';
  const estado = c.nivel === 'zerado' ? ' — *pausada*' : '';
  const cob = c.dias != null ? ` _(≈ ${c.dias.toFixed(1)} dias)_` : '';
  const sug =
    c.sugestao != null
      ? `repor ~*${brl(c.sugestao * 100)}* (cobre ~${DIAS_ALVO} dias)`
      : 'repor (definir valor)';
  const link = `[💳 adicionar fundos](${billingUrl(c.aid)})`;
  return `${emoji} *${c.nome}* (pré-pago): saldo *${brl(c.cents)}*${cob}${estado}\n   → ${sug} · ${link}`;
}

function montarMensagem(alertar) {
  const linhas = alertar.map(linha).join('\n\n');
  return (
    `⚠️ *Reposição de saldo — Tráfego Pago*\n\n` +
    `${linhas}\n\n` +
    `_O link abre a tela de Faturamento da conta → "Adicionar dinheiro" → PIX._\n` +
    `— Fenice Lab · automação`
  );
}

async function enviarTelegram(text) {
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) throw new Error(`Telegram HTTP ${r.status}: ${JSON.stringify(d)}`);
  return d;
}

async function main() {
  if (!DRY_RUN && (!TOKEN || !CHAT_ID)) {
    log('ERRO: TELEGRAM_BOT_TOKEN e ALERTA_CHAT_ID são obrigatórios (ou use DRY_RUN=1).');
    process.exit(2);
  }

  const clients = await fetchSaldo();
  const avaliados = avaliar(clients);
  const prepagos = avaliados.map((c) => `${c.nome}=${brl(c.cents)}[${c.nivel}]`).join(', ');
  log(`Pré-pagos avaliados: ${prepagos || '(nenhum)'} · limite=${brl(LIMITE_CENTS)}`);

  const state = await loadState();
  const day = hoje();
  const alertar = [];

  for (const c of avaliados) {
    const prev = state[c.slug];
    if (c.nivel === 'ok') {
      if (prev) delete state[c.slug]; // recuperou → limpa pra re-alertar se cair de novo
      continue;
    }
    // alerta se: nunca alertou hoje, OU o nível piorou (baixo→zerado)
    const jaAlertouHoje = prev && prev.date === day && prev.nivel === c.nivel;
    if (!jaAlertouHoje) {
      alertar.push(c);
      state[c.slug] = { date: day, nivel: c.nivel };
    }
  }

  if (!alertar.length) {
    log('Nada a alertar (tudo ok ou já alertado hoje).');
    return;
  }

  const msg = montarMensagem(alertar);
  if (DRY_RUN) {
    log('DRY_RUN — mensagem que seria enviada:\n' + msg);
    return;
  }
  await enviarTelegram(msg);
  await saveState(state);
  log(`Alerta enviado p/ ${alertar.length} cliente(s): ${alertar.map((c) => c.slug).join(', ')}`);
}

main().catch((e) => {
  log('FALHOU:', e.message);
  process.exit(1);
});
