// Servidor HTTP — Dashboard de Tráfego Pago (Meta Graph API)
//
// Configuração via variáveis de ambiente (ou .env):
//   PORT                  — porta HTTP (default 3000)
//   META_GRAPH_TOKEN      — Long-Lived Token Meta Graph API (prioridade alta)
//   TOKEN_FILE            — caminho do arquivo .md com token (fallback)
//   CLIENTS_DIR           — pasta raiz dos clientes (pra aliases de assets)
//
// Uso:
//   node server.mjs

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

// === WIZARD CAMPANHAS (auto) ===
import {
  handleDraftSave, handleDraftsList, handleDraftGet, handleSubmit,
  handleApprove, handleReject, handleCreativeUpload, handleAudienceEstimate,
} from './wizard-helpers.mjs';
// === CRIATIVOS HD (auto) ===
import { enrichAdsWithHd, handleAdDetail } from './criativos-hd.mjs';
// === BATTLE MODE (auto) ===
import {
  handleBattleCreate, handleBattleList, handleBattleGet,
  handleBattleCancel, handleBattleDecidir, handleBattleRevert,
} from './battle-helpers.mjs';
import { runBattleCron } from './battle-cron.mjs';
// === AGENDADOR SOCIAL (F1) ===
import { routeSocial } from './social-handlers.mjs';
import { runSocialCron } from './social-cron.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Caminhos configuráveis via env (com defaults sensatos)
const TOKEN_FILE = process.env.TOKEN_FILE
  ? path.resolve(process.env.TOKEN_FILE)
  : path.resolve(__dirname, '..', 'Clientes', 'Tokens', 'Graph API Token.md');

const CLIENTS_DIR = process.env.CLIENTS_DIR
  ? path.resolve(process.env.CLIENTS_DIR)
  : path.resolve(__dirname, '..', 'Clientes');

// Aliases de assets de clientes — lidos de data/client-aliases.json
// (use .example como template e copie pra .json local)
let CLIENT_ALIASES = {};
try {
  const aliasesRaw = await fs.readFile(path.join(__dirname, 'data', 'client-aliases.json'), 'utf-8');
  CLIENT_ALIASES = JSON.parse(aliasesRaw);
} catch {
  console.warn('⚠️  data/client-aliases.json não encontrado — aliases desabilitados');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

// Lê token — prioridade: env var > arquivo .md
async function readToken() {
  if (process.env.META_GRAPH_TOKEN) {
    return process.env.META_GRAPH_TOKEN.trim();
  }
  try {
    const content = await fs.readFile(TOKEN_FILE, 'utf-8');
    const match = content.match(/```token-start\s*\n([\s\S]+?)\n```token-end/);
    if (!match) return null;
    const token = match[1].trim();
    if (token.startsWith('COLE-AQUI') || token.length < 50) return null;
    return token;
  } catch {
    return null;
  }
}

const CACHE_TTL_MS = 60_000;
let cache = { data: null, ts: 0 };
let renovacaoCache = { data: null, ts: 0 };
let adminCache = { data: null, ts: 0 };
let clientsCache = { data: null, ts: 0 };
let saldoCache = { data: null, ts: 0 };
let insightsCache = {}; // keyed por período (since_until ou preset:last_month)
let timeseriesCache = {}; // keyed por slug + período
let campaignsCache = {}; // keyed por slug + período
let adsCache = {};        // keyed por slug + período
let breakdownCache = {};  // keyed por slug + período + breakdown

// === SUPABASE CLIENT (wizard + battle) ===
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createSupabaseClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;
if (!supabase) {
  console.warn('⚠️  SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes — Wizard/Battle desabilitados');
}

// === RBAC ===
// Rotas de AÇÃO (POST /api/campaign/action) SEMPRE exigem ator autenticado.
// Rotas de LEITURA (GET insights/saldo/...) são "graceful": quando STRICT_READ_RBAC
// for false (default), leitura sem auth é apenas logada (warn) mas PERMITIDA — assim
// o iframe público da Arena continua funcionando. Quando true, leitura exige ator
// válido e slug compatível.
const STRICT_READ_RBAC = false;

// Resolve o ator a partir do JWT no header Authorization: Bearer <token>.
// Valida o token com supabase.auth.getUser e busca role/cliente_slug em `usuarios`.
// Retorna { authId, role, clienteSlug } ou null.
async function getActorFromJwt(req) {
  if (!supabase) return null;
  const header = req.headers['authorization'] || req.headers['Authorization'] || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  if (!token) return null;
  try {
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user?.id) return null;
    const authId = userData.user.id;
    const { data: rows, error: rowErr } = await supabase
      .from('usuarios')
      .select('auth_id,role,cliente_slug')
      .eq('auth_id', authId)
      .limit(1);
    if (rowErr || !rows || rows.length === 0) return null;
    return { authId, role: rows[0].role, clienteSlug: rows[0].cliente_slug };
  } catch (e) {
    console.warn('[rbac] getActorFromJwt falhou:', e.message);
    return null;
  }
}

// Guard de LEITURA. Quando STRICT_READ_RBAC=false: loga warn se não houver token e
// PERMITE (retorna true). Quando true: exige ator e valida slug (se houver), enviando
// 401/403 e retornando false pra abortar a rota.
async function guardRead(req, res, slug) {
  if (!STRICT_READ_RBAC) {
    const header = req.headers['authorization'] || req.headers['Authorization'] || '';
    if (!header.startsWith('Bearer ')) {
      console.warn('[rbac] leitura sem auth: ' + req.url);
    }
    return true;
  }
  const actor = await getActorFromJwt(req);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  if (!actor) {
    res.writeHead(401, headers);
    res.end(JSON.stringify({ ok: false, error: 'auth_required' }, null, 2));
    return false;
  }
  if (slug && actor.role !== 'admin_fenice' && actor.clienteSlug !== slug) {
    res.writeHead(403, headers);
    res.end(JSON.stringify({ ok: false, error: 'sem_acesso_ao_slug' }, null, 2));
    return false;
  }
  return true;
}

// Helpers compartilhados pra handlers wizard + battle
async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try { return JSON.parse(body || '{}'); } catch { return {}; }
}
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function loadMapping() {
  try {
    const raw = await fs.readFile(path.join(__dirname, 'data', 'clients-mapping.json'), 'utf-8');
    return JSON.parse(raw);
  } catch { return { clients: [] }; }
}

// ──────────────────────────────────────────────────────────────────────────────
// BASIC AUTH (área admin)
// ──────────────────────────────────────────────────────────────────────────────
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;

function requireAdminAuth(req, res) {
  if (!ADMIN_USER || !ADMIN_PASS) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Admin area desabilitada — defina ADMIN_USER e ADMIN_PASS no .env do servidor.');
    return false;
  }
  const header = req.headers['authorization'] || '';
  if (header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
      const idx = decoded.indexOf(':');
      if (idx > 0) {
        const u = decoded.slice(0, idx);
        const p = decoded.slice(idx + 1);
        if (u === ADMIN_USER && p === ADMIN_PASS) return true;
      }
    } catch {}
  }
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Fenice Admin", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end('Autenticação necessária');
  return false;
}

// ──────────────────────────────────────────────────────────────────────────────
// ADMIN — agregação de status de tokens, páginas e ad accounts
// ──────────────────────────────────────────────────────────────────────────────
async function fetchAdminStatus() {
  const now = Date.now();
  if (adminCache.data && (now - adminCache.ts) < CACHE_TTL_MS) return adminCache.data;

  const token = await readToken();
  if (!token) {
    return {
      updated_at: new Date().toISOString(),
      error: 'token_not_found',
      message: 'Token não encontrado. Configure META_GRAPH_TOKEN ou TOKEN_FILE.',
    };
  }

  // 1. Validação do User Token + app usage (headers)
  let user = null;
  let appUsage = null;
  let userErr = null;
  try {
    const r = await fetch(`https://graph.facebook.com/v23.0/me?fields=id,name,email&access_token=${token}`);
    const usage = r.headers.get('x-app-usage');
    if (usage) { try { appUsage = JSON.parse(usage); } catch {} }
    const j = await r.json();
    if (j.error) userErr = j.error;
    else user = j;
  } catch (e) { userErr = { message: e.message }; }

  // 2. debug_token — escopo + expiração
  let debug = null;
  let debugErr = null;
  try {
    const r = await fetch(`https://graph.facebook.com/v23.0/debug_token?input_token=${token}&access_token=${token}`);
    const j = await r.json();
    if (j.error) debugErr = j.error;
    else debug = j.data;
  } catch (e) { debugErr = { message: e.message }; }

  // 2b. Carrega mapping de clientes (pra enriquecer com agencia + buscar páginas não-listadas via page_id direto)
  let clientsMapping = { clients: [] };
  try {
    const mappingRaw = await fs.readFile(path.join(__dirname, 'data', 'clients-mapping.json'), 'utf-8');
    clientsMapping = JSON.parse(mappingRaw);
  } catch {}
  const pageIdToClient = {};
  const adAccountIdToClient = {};
  clientsMapping.clients.forEach(c => {
    if (c.page_id) pageIdToClient[c.page_id] = c;
    if (c.ad_account_id) adAccountIdToClient[c.ad_account_id] = c;
  });

  const mapPageData = (p, source) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    tasks: p.tasks || [],
    has_page_token: !!p.access_token,
    source,
    agencia: pageIdToClient[p.id]?.agencia || null,
    cliente_slug: pageIdToClient[p.id]?.slug || null,
    instagram: p.instagram_business_account ? {
      id: p.instagram_business_account.id,
      username: p.instagram_business_account.username,
      name: p.instagram_business_account.name,
      followers: p.instagram_business_account.followers_count,
      avatar: p.instagram_business_account.profile_picture_url,
    } : null,
  });

  // 3. Páginas via /me/accounts (rota natural)
  let pages = [];
  let pagesErr = null;
  try {
    const r = await fetch(`https://graph.facebook.com/v23.0/me/accounts?fields=id,name,access_token,category,tasks,instagram_business_account{id,username,name,followers_count,profile_picture_url}&limit=100&access_token=${token}`);
    const j = await r.json();
    if (j.error) pagesErr = j.error;
    else pages = (j.data || []).map(p => mapPageData(p, 'me/accounts'));
  } catch (e) { pagesErr = { message: e.message }; }

  // 3b. Páginas mapeadas mas NÃO retornadas por /me/accounts → buscar via page_id direto
  // (caso Suprema: acesso via BM, não via /me/accounts)
  const foundIds = new Set(pages.map(p => p.id));
  const missingMapped = clientsMapping.clients.filter(c => c.page_id && !foundIds.has(c.page_id));
  if (missingMapped.length) {
    const extras = await Promise.all(missingMapped.map(async (c) => {
      try {
        const r = await fetch(`https://graph.facebook.com/v23.0/${c.page_id}?fields=id,name,access_token,category,instagram_business_account{id,username,name,followers_count,profile_picture_url}&access_token=${token}`);
        const j = await r.json();
        if (j.error || !j.id) return null;
        return mapPageData(j, 'direct');
      } catch { return null; }
    }));
    extras.filter(Boolean).forEach(p => pages.push(p));
  }

  // Pendentes (clientes Fenice Lab sem page_id ainda)
  const pendingClients = clientsMapping.clients
    .filter(c => !c.page_id && c.agencia === 'Fenice Lab')
    .map(c => ({
      id: null,
      name: c.name,
      pending: true,
      status: c.status || 'Aguardando setup',
      agencia: c.agencia,
      cliente_slug: c.slug,
      ad_account_id: c.ad_account_id || null,
    }));

  // 4. Ad accounts
  let adAccounts = [];
  let adAccountsErr = null;
  try {
    const r = await fetch(`https://graph.facebook.com/v23.0/me/adaccounts?fields=id,account_id,name,account_status,disable_reason,currency,timezone_name,balance,amount_spent,spend_cap,business{id,name}&limit=200&access_token=${token}`);
    const j = await r.json();
    if (j.error) adAccountsErr = j.error;
    else adAccounts = (j.data || []).map(a => ({
      id: a.id,
      account_id: a.account_id,
      name: a.name,
      status: a.account_status,
      disable_reason: a.disable_reason,
      currency: a.currency,
      timezone: a.timezone_name,
      balance_cents: a.balance ? parseInt(a.balance) : null,
      amount_spent_cents: a.amount_spent ? parseInt(a.amount_spent) : null,
      spend_cap_cents: a.spend_cap ? parseInt(a.spend_cap) : null,
      business: a.business ? { id: a.business.id, name: a.business.name } : null,
      agencia: adAccountIdToClient[a.account_id]?.agencia || null,
      cliente_slug: adAccountIdToClient[a.account_id]?.slug || null,
      cliente_nome: adAccountIdToClient[a.account_id]?.name || null,
    }));
  } catch (e) { adAccountsErr = { message: e.message }; }

  // 5. Business managers acessíveis
  let businesses = [];
  let businessesErr = null;
  try {
    const r = await fetch(`https://graph.facebook.com/v23.0/me/businesses?fields=id,name,verification_status,created_time&limit=50&access_token=${token}`);
    const j = await r.json();
    if (j.error) businessesErr = j.error;
    else businesses = j.data || [];
  } catch (e) { businessesErr = { message: e.message }; }

  // 6. Calcula dias até expirar (debug.expires_at é unix ts em seg; 0 = não expira)
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = debug?.expires_at && debug.expires_at > 0 ? debug.expires_at : null;
  const dataAccessExp = debug?.data_access_expires_at && debug.data_access_expires_at > 0 ? debug.data_access_expires_at : null;
  const daysLeft = expiresAt ? Math.floor((expiresAt - nowSec) / 86400) : null;
  // Pra tokens que não expiram, usar data_access_expires_at (90 dias) como heads-up
  const daysLeftDataAccess = dataAccessExp ? Math.floor((dataAccessExp - nowSec) / 86400) : null;

  let tokenHealth = 'unknown';
  let nonExpiring = false;
  if (userErr) tokenHealth = 'invalid';
  else if (debug?.expires_at === 0) {
    // Token "permanente" (admin/dev/tester do app). Verificar só data access.
    nonExpiring = true;
    if (daysLeftDataAccess === null) tokenHealth = 'ok';
    else if (daysLeftDataAccess <= 0) tokenHealth = 'expired';
    else if (daysLeftDataAccess < 7) tokenHealth = 'critical';
    else if (daysLeftDataAccess < 14) tokenHealth = 'warn';
    else tokenHealth = 'ok';
  }
  else if (daysLeft === null) tokenHealth = 'unknown';
  else if (daysLeft <= 0) tokenHealth = 'expired';
  else if (daysLeft < 7) tokenHealth = 'critical';
  else if (daysLeft < 14) tokenHealth = 'warn';
  else tokenHealth = 'ok';

  const result = {
    updated_at: new Date().toISOString(),
    token: {
      health: tokenHealth,
      valid: !userErr,
      user,
      user_error: userErr,
      expires_at: expiresAt,
      days_left: daysLeft,
      data_access_expires_at: dataAccessExp,
      days_left_data_access: daysLeftDataAccess,
      non_expiring: nonExpiring,
      scopes: debug?.scopes || [],
      app_id: debug?.app_id || null,
      type: debug?.type || null,
      issued_at: debug?.issued_at || null,
      debug_error: debugErr,
    },
    app_usage: appUsage,
    pages,
    pages_error: pagesErr,
    pages_count: pages.length,
    pages_with_ig: pages.filter(p => p.instagram).length,
    pending_clients: pendingClients,
    ad_accounts: adAccounts,
    ad_accounts_error: adAccountsErr,
    ad_accounts_count: adAccounts.length,
    businesses,
    businesses_error: businessesErr,
  };

  adminCache = { data: result, ts: now };
  return result;
}

async function fetchAgendamentos() {
  const now = Date.now();
  if (cache.data && (now - cache.ts) < CACHE_TTL_MS) return cache.data;

  const token = await readToken();
  if (!token) {
    return {
      updated_at: new Date().toISOString(),
      error: 'token_not_found',
      message: 'Token não encontrado. Configure META_GRAPH_TOKEN (env) ou preencha TOKEN_FILE.',
      clients: [],
      crons: [],
    };
  }

  let mapping;
  try {
    const mappingRaw = await fs.readFile(path.join(__dirname, 'data', 'clients-mapping.json'), 'utf-8');
    mapping = JSON.parse(mappingRaw);
  } catch {
    return { updated_at: new Date().toISOString(), error: 'clients_mapping_missing', message: 'data/clients-mapping.json não encontrado. Use o .example como template.', clients: [], crons: [] };
  }

  let cronsData = { crons: [] };
  try {
    const cronsRaw = await fs.readFile(path.join(__dirname, 'data', 'crons.json'), 'utf-8');
    cronsData = JSON.parse(cronsRaw);
  } catch {}

  const clientPromises = mapping.clients.map(async (client) => {
    try {
      const tokenUrl = `https://graph.facebook.com/v23.0/${client.page_id}?fields=access_token&access_token=${token}`;
      const tokenRes = await fetch(tokenUrl);
      const tokenData = await tokenRes.json();
      const pageToken = tokenData.access_token;
      if (!pageToken) {
        return { ...client, fb_scheduled_posts: [], error: tokenData.error?.message || 'Page access token não disponível' };
      }

      const url = `https://graph.facebook.com/v23.0/${client.page_id}/scheduled_posts?fields=id,scheduled_publish_time,is_published,attachments,created_time,full_picture,permalink_url&access_token=${pageToken}`;
      const res = await fetch(url);
      const data = await res.json();

      const fbScheduled = (data.data || []).map((p) => ({
        id: p.id,
        scheduled_publish_time: p.scheduled_publish_time,
        scheduled_publish_iso: new Date(p.scheduled_publish_time * 1000).toISOString(),
        time_remaining_seconds: p.scheduled_publish_time - Math.floor(Date.now() / 1000),
        message_preview: p.attachments?.data?.[0]?.description || '',
        image_url: p.full_picture || null,
        permalink: p.permalink_url || null,
      }));

      return {
        ...client,
        fb_scheduled_posts: fbScheduled,
        error: data.error?.message || null,
      };
    } catch (err) {
      return { ...client, fb_scheduled_posts: [], error: err.message };
    }
  });

  const clients = await Promise.all(clientPromises);

  let tokenValid = false;
  let tokenInfo = null;
  try {
    const meRes = await fetch(`https://graph.facebook.com/v23.0/me?fields=id,name&access_token=${token}`);
    const me = await meRes.json();
    if (me.id) {
      tokenValid = true;
      tokenInfo = { user_id: me.id, name: me.name };
    }
  } catch {}

  const result = {
    updated_at: new Date().toISOString(),
    token_status: tokenValid ? 'valid' : 'invalid_or_expired',
    token_info: tokenInfo,
    clients,
    crons: cronsData.crons,
  };

  cache = { data: result, ts: now };
  return result;
}

async function fetchRenovacao() {
  const now = Date.now();
  if (renovacaoCache.data && (now - renovacaoCache.ts) < CACHE_TTL_MS) return renovacaoCache.data;

  const token = await readToken();
  if (!token) {
    return { error: 'token_not_found', mes: null, campanhas: [] };
  }

  let cfg;
  try {
    const cfgRaw = await fs.readFile(path.join(__dirname, 'data', 'renovacao-mes.json'), 'utf-8');
    cfg = JSON.parse(cfgRaw);
  } catch {
    return { error: 'config_missing', message: 'data/renovacao-mes.json não encontrado. Use o .example como template.', mes: null, campanhas: [] };
  }

  const enriched = await Promise.all(cfg.campanhas.map(async (c) => {
    if (!c.campaign_id || !c.ad_account_id || c.budget_type === 'manual') {
      return { ...c, metrics: null };
    }
    try {
      const [maxRes, lastRes] = await Promise.all([
        fetch(`https://graph.facebook.com/v23.0/${c.campaign_id}/insights?fields=spend,impressions,actions,purchase_roas&date_preset=maximum&access_token=${token}`),
        fetch(`https://graph.facebook.com/v23.0/${c.campaign_id}/insights?fields=spend,impressions,actions,purchase_roas&date_preset=last_month&access_token=${token}`)
      ]);
      const maxData = await maxRes.json();
      const lastData = await lastRes.json();

      const parseInsight = (d) => {
        const row = d.data?.[0];
        if (!row) return null;
        const omni = (row.actions || []).find(a => a.action_type === 'omni_purchase');
        const roas = row.purchase_roas?.[0]?.value || row.purchase_roas?.find?.(r => r.action_type === 'omni_purchase')?.value;
        return {
          spend: parseFloat(row.spend || 0),
          impressions: parseInt(row.impressions || 0),
          purchases: parseInt(omni?.value || 0),
          roas: parseFloat(roas || 0),
        };
      };

      return {
        ...c,
        metrics: {
          historico: parseInsight(maxData),
          mes_anterior: parseInsight(lastData),
        }
      };
    } catch (err) {
      return { ...c, metrics: null, error: err.message };
    }
  }));

  const result = {
    mes: cfg.mes,
    mes_label: cfg.mes_label,
    atualizado_em: new Date().toISOString(),
    resumo: {
      total: cfg.campanhas.length,
      renovadas: cfg.campanhas.filter(c => c.status === 'renovada').length,
      pendentes: cfg.campanhas.filter(c => c.status === 'pendente').length,
      manuais: cfg.campanhas.filter(c => c.status === 'manual').length,
      investimento_total_mes_cents: cfg.campanhas.reduce((s, c) => s + (c.budget_novo_mes_cents || 0), 0),
    },
    campanhas: enriched,
  };

  renovacaoCache = { data: result, ts: now };
  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// PÚBLICO — lista de clientes ativos sem dados financeiros (pra central pública)
// ──────────────────────────────────────────────────────────────────────────────
async function fetchPublicClients() {
  const now = Date.now();
  if (clientsCache.data && (now - clientsCache.ts) < CACHE_TTL_MS) return clientsCache.data;

  let mapping = { clients: [] };
  try {
    const raw = await fs.readFile(path.join(__dirname, 'data', 'clients-mapping.json'), 'utf-8');
    mapping = JSON.parse(raw);
  } catch {
    return { error: 'mapping_missing', clients: [], updated_at: new Date().toISOString() };
  }

  const token = await readToken();
  const clients = await Promise.all(mapping.clients.map(async (c) => {
    let igData = null;
    if (token && c.ig_business_id) {
      try {
        const r = await fetch(`https://graph.facebook.com/v23.0/${c.ig_business_id}?fields=username,name,followers_count,media_count,profile_picture_url&access_token=${token}`);
        const j = await r.json();
        if (!j.error) {
          igData = {
            username: j.username || c.ig_username,
            name: j.name,
            followers: j.followers_count,
            media_count: j.media_count,
            avatar: j.profile_picture_url,
          };
        }
      } catch {}
    } else if (c.ig_username) {
      igData = { username: c.ig_username };
    }
    return {
      name: c.name,
      slug: c.slug,
      agencia: c.agencia,
      validated: c.validated,
      pending_status: c.validated === false ? (c.status || 'Em setup') : null,
      instagram: igData,
      // SEM gasto, sem ROAS, sem balance — apenas info pública
    };
  }));

  const result = {
    updated_at: new Date().toISOString(),
    by_agencia: {
      'Fenice Lab': clients.filter(c => c.agencia === 'Fenice Lab'),
      'Starken': clients.filter(c => c.agencia === 'Starken'),
      'Outros': clients.filter(c => c.agencia !== 'Fenice Lab' && c.agencia !== 'Starken'),
    },
    clients,
  };
  clientsCache = { data: result, ts: now };
  return result;
}

function resolveFilePath(reqUrl) {
  let urlPath = decodeURIComponent(reqUrl.split('?')[0]);
  // Diretório raiz vira index.html
  if (urlPath === '/') urlPath = '/index.html';
  // Alias: /dashboard e /dashboard/ → mesma central da raiz
  if (urlPath === '/dashboard' || urlPath === '/dashboard/') urlPath = '/index.html';
  // Qualquer URL terminando em / também aponta pro index.html da pasta
  if (urlPath.endsWith('/')) urlPath = urlPath + 'index.html';

  const clientMatch = urlPath.match(/^\/clientes\/([^\/]+)\/(.+)$/);
  if (clientMatch) {
    const slug = clientMatch[1].toLowerCase();
    const fileName = clientMatch[2];
    const clientFolder = CLIENT_ALIASES[slug];
    if (clientFolder) {
      const target = path.join(CLIENTS_DIR, clientFolder, fileName);
      if (target.startsWith(CLIENTS_DIR)) return { filePath: target, scope: 'client' };
    }
    return null;
  }

  const filePath = path.join(__dirname, urlPath);
  if (filePath.startsWith(__dirname)) return { filePath, scope: 'dashboard' };
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// PÚBLICO — saldo das contas de anúncios (balance) por cliente. Sem dados sensíveis
// de campanha; só saldo/gasto/limite, pra alerta de saldo baixo na central.
// ──────────────────────────────────────────────────────────────────────────────
async function fetchSaldos() {
  const now = Date.now();
  if (saldoCache.data && (now - saldoCache.ts) < CACHE_TTL_MS) return saldoCache.data;

  let mapping = { clients: [] };
  try {
    const raw = await fs.readFile(path.join(__dirname, 'data', 'clients-mapping.json'), 'utf-8');
    mapping = JSON.parse(raw);
  } catch {
    return { updated_at: new Date().toISOString(), error: 'mapping_missing', clients: [] };
  }

  const token = await readToken();
  let byAcct = {};
  let erro = null;
  if (token) {
    try {
      const r = await fetch(`https://graph.facebook.com/v23.0/me/adaccounts?fields=account_id,name,currency,account_status,balance,amount_spent,spend_cap,funding_source,funding_source_details&limit=500&access_token=${token}`);
      const j = await r.json();
      if (j.error) erro = j.error.message || 'graph_error';
      else for (const a of (j.data || [])) byAcct[a.account_id] = a;
    } catch (e) { erro = e.message; }
  } else {
    erro = 'sem_token';
  }

  const clients = mapping.clients
    .filter((c) => c.ad_account_id)
    .map((c) => {
      const a = byAcct[c.ad_account_id];
      const cents = (v) => (v != null && v !== '' ? parseInt(v) : null);
      // tipo de financiamento + saldo disponível (parseado do display_string da Meta)
      const fd = a?.funding_source_details || null;
      const tipo = fd ? (fd.type === 1 ? 'cartao' : fd.type === 20 ? 'prepago' : 'outro') : null;
      let disponivel_cents = null;
      if (tipo === 'prepago' && fd?.display_string) {
        // ex.: "Saldo disponível (R$25,22 BRL)" → 2522
        const m = fd.display_string.match(/R\$\s*([\d.]*\d)(?:,(\d{2}))?/);
        if (m) disponivel_cents = parseInt(m[1].replace(/\./g, ''), 10) * 100 + parseInt(m[2] || '00', 10);
      }
      return {
        slug: c.slug,
        name: c.name,
        agencia: c.agencia || null,
        ad_account_id: c.ad_account_id,
        currency: a?.currency || 'BRL',
        account_status: a?.account_status ?? null,
        balance_cents: a ? cents(a.balance) : null,
        amount_spent_cents: a ? cents(a.amount_spent) : null,
        spend_cap_cents: a ? cents(a.spend_cap) : null,
        funding_source: a?.funding_source ?? null,
        funding_source_details: a?.funding_source_details ?? null,
        funding_tipo: tipo,                                            // 'cartao' | 'prepago' | 'outro'
        disponivel_cents: tipo === 'prepago' ? disponivel_cents : null, // saldo pré-pago disponível
        a_faturar_cents: tipo === 'cartao' ? (a ? cents(a.balance) : null) : null, // valor a faturar no cartão
        found: !!a,
      };
    });

  const result = { updated_at: new Date().toISOString(), error: erro, clients };
  saldoCache = { data: result, ts: now };
  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// PÚBLICO — insights de mídia paga por cliente (account-level), por período.
// Puxa via Graph (act_<id>/insights). Funciona inclusive em contas NÃO MCP-enabled
// (ex.: Arena) — o gate do MCP não vale pro Graph direto.
// ──────────────────────────────────────────────────────────────────────────────
const actVal = (arr, type) => {
  const f = (arr || []).find((x) => x.action_type === type);
  return f ? Number(f.value) : null;
};

async function fetchInsights({ since, until, preset } = {}) {
  const periodKey = since && until ? `${since}_${until}` : `preset:${preset || 'last_month'}`;
  const now = Date.now();
  const cached = insightsCache[periodKey];
  if (cached && (now - cached.ts) < CACHE_TTL_MS) return cached.data;

  let mapping = { clients: [] };
  try {
    const raw = await fs.readFile(path.join(__dirname, 'data', 'clients-mapping.json'), 'utf-8');
    mapping = JSON.parse(raw);
  } catch {
    return { updated_at: new Date().toISOString(), error: 'mapping_missing', clients: [] };
  }

  const token = await readToken();
  if (!token) return { updated_at: new Date().toISOString(), error: 'sem_token', clients: [] };

  const rangeParam = since && until
    ? `time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`
    : `date_preset=${encodeURIComponent(preset || 'last_month')}`;
  const fields = 'spend,impressions,reach,frequency,clicks,ctr,cpm,cpc,purchase_roas,actions,action_values';

  const targets = mapping.clients.filter((c) => c.ad_account_id);
  const clients = await Promise.all(targets.map(async (c) => {
    const base = { slug: c.slug, name: c.name, agencia: c.agencia || null, ad_account_id: c.ad_account_id };
    try {
      const url = `https://graph.facebook.com/v23.0/act_${c.ad_account_id}/insights?level=account&fields=${fields}&${rangeParam}&access_token=${token}`;
      const r = await fetch(url);
      const j = await r.json();
      if (j.error) return { ...base, found: false, error: j.error.message };
      const a = (j.data || [])[0];
      if (!a) return { ...base, found: false, error: null };
      const purchases = actVal(a.actions, 'omni_purchase');
      const revenue = actVal(a.action_values, 'omni_purchase');
      const num = (v) => (v != null && v !== '' ? Number(v) : null);
      return {
        ...base,
        found: true,
        error: null,
        spend_cents: a.spend != null ? Math.round(Number(a.spend) * 100) : null,
        revenue_cents: revenue != null ? Math.round(revenue * 100) : null,
        purchases: purchases != null ? Math.round(purchases) : null,
        roas: actVal(a.purchase_roas, 'omni_purchase'),
        impressions: num(a.impressions),
        reach: num(a.reach),
        frequency: num(a.frequency),
        clicks: num(a.clicks),
        ctr: num(a.ctr),
        cpm: num(a.cpm),
        cpc: num(a.cpc),
        link_clicks: actVal(a.actions, 'link_click'),
        add_to_cart: actVal(a.actions, 'add_to_cart'),
        initiate_checkout: actVal(a.actions, 'initiate_checkout'),
      };
    } catch (e) {
      return { ...base, found: false, error: e.message };
    }
  }));

  const result = { updated_at: new Date().toISOString(), period: periodKey, clients };
  insightsCache[periodKey] = { data: result, ts: now };
  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// /api/timeseries — insights dia-a-dia (Onda 2)
// /api/campaigns  — lista campanhas + insights agregado (Onda 3)
// /api/ads        — lista ads com criativo + insights (Onda 4)
// /api/breakdown  — insights segmentado por dimensão (Onda 4)
// Todos por slug; lookup do ad_account_id no mapping; cache 60s.
// ──────────────────────────────────────────────────────────────────────────────
async function readMappingClient(slug) {
  const raw = await fs.readFile(path.join(__dirname, 'data', 'clients-mapping.json'), 'utf-8');
  const map = JSON.parse(raw);
  return (map.clients || []).find((c) => c.slug === slug && c.ad_account_id);
}

async function fetchTimeseries({ slug, since, until, preset } = {}) {
  const periodKey = `${slug}|${since && until ? `${since}_${until}` : `preset:${preset || 'last_month'}`}`;
  const now = Date.now();
  const cached = timeseriesCache[periodKey];
  if (cached && (now - cached.ts) < CACHE_TTL_MS) return cached.data;

  const c = await readMappingClient(slug);
  if (!c) return { updated_at: new Date().toISOString(), slug, error: 'cliente_nao_encontrado', days: [] };
  const token = await readToken();
  if (!token) return { updated_at: new Date().toISOString(), slug, error: 'sem_token', days: [] };

  const rangeParam = since && until
    ? `time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`
    : `date_preset=${encodeURIComponent(preset || 'last_month')}`;
  const fields = 'spend,impressions,reach,clicks,ctr,cpm,cpc,purchase_roas,actions,action_values';
  const url = `https://graph.facebook.com/v23.0/act_${c.ad_account_id}/insights?level=account&time_increment=1&fields=${fields}&${rangeParam}&limit=500&access_token=${token}`;

  let days = [];
  let error = null;
  try {
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) error = j.error.message;
    else {
      days = (j.data || []).map((d) => ({
        date: d.date_start,
        spend_cents: d.spend != null ? Math.round(Number(d.spend) * 100) : null,
        revenue_cents: (() => { const v = actVal(d.action_values, 'omni_purchase'); return v != null ? Math.round(v * 100) : null; })(),
        purchases: actVal(d.actions, 'omni_purchase'),
        roas: actVal(d.purchase_roas, 'omni_purchase'),
        impressions: d.impressions != null ? Number(d.impressions) : null,
        reach: d.reach != null ? Number(d.reach) : null,
        clicks: d.clicks != null ? Number(d.clicks) : null,
        ctr: d.ctr != null ? Number(d.ctr) : null,
        cpm: d.cpm != null ? Number(d.cpm) : null,
        link_clicks: actVal(d.actions, 'link_click'),
        add_to_cart: actVal(d.actions, 'add_to_cart'),
      }));
    }
  } catch (e) {
    error = e.message;
  }

  const result = { updated_at: new Date().toISOString(), slug, period: periodKey, error, days };
  timeseriesCache[periodKey] = { data: result, ts: now };
  return result;
}

async function fetchCampaigns({ slug, since, until, preset } = {}) {
  const periodKey = `${slug}|${since && until ? `${since}_${until}` : `preset:${preset || 'last_month'}`}`;
  const now = Date.now();
  const cached = campaignsCache[periodKey];
  if (cached && (now - cached.ts) < CACHE_TTL_MS) return cached.data;

  const c = await readMappingClient(slug);
  if (!c) return { updated_at: new Date().toISOString(), slug, error: 'cliente_nao_encontrado', campaigns: [] };
  const token = await readToken();
  if (!token) return { updated_at: new Date().toISOString(), slug, error: 'sem_token', campaigns: [] };

  const rangeParam = since && until
    ? `time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`
    : `date_preset=${encodeURIComponent(preset || 'last_month')}`;
  const fields = 'campaign_id,campaign_name,spend,impressions,reach,frequency,clicks,ctr,cpc,purchase_roas,actions,action_values';
  const url = `https://graph.facebook.com/v23.0/act_${c.ad_account_id}/insights?level=campaign&fields=${fields}&${rangeParam}&limit=200&access_token=${token}`;

  // Meta dos campanhas (status/objective/budget) — uma chamada separada
  const metaUrl = `https://graph.facebook.com/v23.0/act_${c.ad_account_id}/campaigns?fields=id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time,created_time&limit=200&access_token=${token}`;

  let campaigns = [];
  let error = null;
  try {
    const [insR, metaR] = await Promise.all([fetch(url), fetch(metaUrl)]);
    const ins = await insR.json();
    const meta = await metaR.json();
    if (ins.error) { error = ins.error.message; }
    const metaById = {};
    for (const m of (meta.data || [])) metaById[m.id] = m;
    campaigns = (ins.data || []).map((row) => {
      const m = metaById[row.campaign_id] || {};
      const purchases = actVal(row.actions, 'omni_purchase');
      const revenue = actVal(row.action_values, 'omni_purchase');
      const spend_cents = row.spend != null ? Math.round(Number(row.spend) * 100) : null;
      return {
        campaign_id: row.campaign_id,
        name: row.campaign_name || m.name || row.campaign_id,
        status: m.status || null,
        effective_status: m.effective_status || null,
        objective: m.objective || null,
        daily_budget_cents: m.daily_budget ? Number(m.daily_budget) : null,
        lifetime_budget_cents: m.lifetime_budget ? Number(m.lifetime_budget) : null,
        start_time: m.start_time || null,
        stop_time: m.stop_time || null,
        spend_cents,
        revenue_cents: revenue != null ? Math.round(revenue * 100) : null,
        purchases: purchases != null ? Math.round(purchases) : null,
        roas: actVal(row.purchase_roas, 'omni_purchase'),
        impressions: row.impressions != null ? Number(row.impressions) : null,
        reach: row.reach != null ? Number(row.reach) : null,
        frequency: row.frequency != null ? Number(row.frequency) : null,
        clicks: row.clicks != null ? Number(row.clicks) : null,
        ctr: row.ctr != null ? Number(row.ctr) : null,
        cpc: row.cpc != null ? Number(row.cpc) : null,
        cpa_cents: purchases && spend_cents ? Math.round(spend_cents / purchases) : null,
      };
    });
    // Ordena por ROAS desc (Pareto: top em cima)
    campaigns.sort((a, b) => (b.roas || 0) - (a.roas || 0));
  } catch (e) {
    error = e.message;
  }

  const result = { updated_at: new Date().toISOString(), slug, period: periodKey, error, campaigns };
  campaignsCache[periodKey] = { data: result, ts: now };
  return result;
}

async function fetchAds({ slug, since, until, preset, campaign_id } = {}) {
  const periodKey = `${slug}|${campaign_id || 'all'}|${since && until ? `${since}_${until}` : `preset:${preset || 'last_month'}`}`;
  const now = Date.now();
  const cached = adsCache[periodKey];
  if (cached && (now - cached.ts) < CACHE_TTL_MS) return cached.data;

  const c = await readMappingClient(slug);
  if (!c) return { updated_at: new Date().toISOString(), slug, error: 'cliente_nao_encontrado', ads: [] };
  const token = await readToken();
  if (!token) return { updated_at: new Date().toISOString(), slug, error: 'sem_token', ads: [] };

  const rangeParam = since && until
    ? `time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`
    : `date_preset=${encodeURIComponent(preset || 'last_month')}`;
  // Insights por ad
  const insFields = 'ad_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,spend,impressions,reach,clicks,ctr,purchase_roas,actions,action_values';
  // Filtro por campaign_id (drill-down) via parâmetro `filtering` da Meta
  const filtering = campaign_id
    ? `&filtering=${encodeURIComponent(JSON.stringify([{ field: 'campaign.id', operator: 'EQUAL', value: String(campaign_id) }]))}`
    : '';
  const insUrl = `https://graph.facebook.com/v23.0/act_${c.ad_account_id}/insights?level=ad&fields=${insFields}&${rangeParam}${filtering}&limit=200&access_token=${token}`;

  let ads = [];
  let error = null;
  try {
    const r = await fetch(insUrl);
    const ins = await r.json();
    if (ins.error) {
      error = ins.error.message;
    } else {
      const rows = (ins.data || []);
      // Enriquece com criativo (thumbnail + body + title) — em paralelo, limit 30 pra não estourar
      const adIds = rows.slice(0, 30).map((r) => r.ad_id).filter(Boolean);
      const creativeById = {};
      if (adIds.length > 0) {
        const url = `https://graph.facebook.com/v23.0/?ids=${adIds.join(',')}&fields=creative{thumbnail_url,image_url,body,title,object_story_spec},name,status,effective_status&access_token=${token}`;
        try {
          const cr = await fetch(url);
          const cj = await cr.json();
          for (const id of Object.keys(cj || {})) {
            if (id === 'error') continue;
            creativeById[id] = cj[id];
          }
        } catch {}
      }
      ads = rows.map((row) => {
        const purchases = actVal(row.actions, 'omni_purchase');
        const revenue = actVal(row.action_values, 'omni_purchase');
        const spend_cents = row.spend != null ? Math.round(Number(row.spend) * 100) : null;
        const adMeta = creativeById[row.ad_id] || {};
        const cr = adMeta.creative || {};
        return {
          ad_id: row.ad_id,
          name: row.ad_name || adMeta.name || row.ad_id,
          status: adMeta.status || null,
          effective_status: adMeta.effective_status || null,
          campaign_id: row.campaign_id,
          campaign_name: row.campaign_name,
          adset_id: row.adset_id,
          adset_name: row.adset_name,
          thumbnail_url: cr.thumbnail_url || cr.image_url || null,
          headline: cr.title || null,
          body: cr.body || null,
          spend_cents,
          revenue_cents: revenue != null ? Math.round(revenue * 100) : null,
          purchases: purchases != null ? Math.round(purchases) : null,
          roas: actVal(row.purchase_roas, 'omni_purchase'),
          impressions: row.impressions != null ? Number(row.impressions) : null,
          reach: row.reach != null ? Number(row.reach) : null,
          clicks: row.clicks != null ? Number(row.clicks) : null,
          ctr: row.ctr != null ? Number(row.ctr) : null,
          link_clicks: actVal(row.actions, 'link_click'),
        };
      });
      // Ordena por ROAS desc
      ads.sort((a, b) => (b.roas || 0) - (a.roas || 0));
    }
  } catch (e) {
    error = e.message;
  }

  // === CRIATIVOS HD (auto) — enriquece ads com image_url_hd/thumb_url_hd
  const adsEnriched = (!error && ads.length > 0 && c.ad_account_id)
    ? await enrichAdsWithHd(ads, c.ad_account_id).catch((e) => { console.warn('[ads-hd] fallback:', e.message); return ads; })
    : ads;
  const result = { updated_at: new Date().toISOString(), slug, period: periodKey, error, ads: adsEnriched };
  adsCache[periodKey] = { data: result, ts: now };
  return result;
}

async function fetchBreakdown({ slug, breakdowns, since, until, preset } = {}) {
  if (!breakdowns) return { error: 'breakdowns_required', rows: [] };
  const periodKey = `${slug}|${breakdowns}|${since && until ? `${since}_${until}` : `preset:${preset || 'last_month'}`}`;
  const now = Date.now();
  const cached = breakdownCache[periodKey];
  if (cached && (now - cached.ts) < CACHE_TTL_MS) return cached.data;

  const c = await readMappingClient(slug);
  if (!c) return { updated_at: new Date().toISOString(), slug, error: 'cliente_nao_encontrado', rows: [] };
  const token = await readToken();
  if (!token) return { updated_at: new Date().toISOString(), slug, error: 'sem_token', rows: [] };

  const rangeParam = since && until
    ? `time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`
    : `date_preset=${encodeURIComponent(preset || 'last_month')}`;
  const fields = 'spend,impressions,reach,clicks,ctr,purchase_roas,actions,action_values';
  const url = `https://graph.facebook.com/v23.0/act_${c.ad_account_id}/insights?level=account&fields=${fields}&breakdowns=${encodeURIComponent(breakdowns)}&${rangeParam}&limit=500&access_token=${token}`;

  let rows = [];
  let error = null;
  try {
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) error = j.error.message;
    else {
      rows = (j.data || []).map((row) => {
        const purchases = actVal(row.actions, 'omni_purchase');
        const revenue = actVal(row.action_values, 'omni_purchase');
        const out = {
          spend_cents: row.spend != null ? Math.round(Number(row.spend) * 100) : null,
          revenue_cents: revenue != null ? Math.round(revenue * 100) : null,
          purchases: purchases != null ? Math.round(purchases) : null,
          roas: actVal(row.purchase_roas, 'omni_purchase'),
          impressions: row.impressions != null ? Number(row.impressions) : null,
          reach: row.reach != null ? Number(row.reach) : null,
          clicks: row.clicks != null ? Number(row.clicks) : null,
          ctr: row.ctr != null ? Number(row.ctr) : null,
          link_clicks: actVal(row.actions, 'link_click'),
        };
        // Copia os campos de breakdown (age, gender, publisher_platform, hourly_stats_*, etc)
        for (const k of Object.keys(row)) {
          if (!(k in out) && k !== 'date_start' && k !== 'date_stop' && k !== 'actions' && k !== 'action_values'
              && k !== 'spend' && k !== 'impressions' && k !== 'reach' && k !== 'clicks' && k !== 'ctr' && k !== 'purchase_roas') {
            out[k] = row[k];
          }
        }
        return out;
      });
    }
  } catch (e) {
    error = e.message;
  }

  const result = { updated_at: new Date().toISOString(), slug, breakdowns, period: periodKey, error, rows };
  breakdownCache[periodKey] = { data: result, ts: now };
  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/campaign/action — quick action operacional (Pausar/Reativar/+budget)
// Body JSON novo: { slug, entity_type: 'campaign'|'adset'|'ad', entity_id, action, factor }
// Body JSON antigo (retrocompat): { slug, campaign_id, action, factor }
// Valida que a entidade pertence ao ad_account_id do slug antes de mexer.
// budget_up/budget_down só pra campaign. Requer token Meta com scope ads_management.
// ──────────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────────
// Audit log — JSONL append-only em data/audit-log.jsonl
// Toda chamada de postEntityAction grava 1 linha (ok ou erro).
// ──────────────────────────────────────────────────────────────────────────────
const AUDIT_LOG_PATH = path.join(__dirname, 'data', 'audit-log.jsonl');
const AUDIT_LOG_MAX_BYTES = 10 * 1024 * 1024;  // 10 MB — rotaciona quando ultrapassa

/** Rotaciona o jsonl se ultrapassou o cap. Move pra audit-log.archive-<YYYYMMDD-HHMMSS>.jsonl. */
async function rotateAuditLogIfNeeded() {
  try {
    const stat = await fs.stat(AUDIT_LOG_PATH);
    if (stat.size < AUDIT_LOG_MAX_BYTES) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const archive = path.join(path.dirname(AUDIT_LOG_PATH), `audit-log.archive-${ts}.jsonl`);
    await fs.rename(AUDIT_LOG_PATH, archive);
    console.log(`audit log rotated → ${path.basename(archive)} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('audit log rotation failed:', e.message);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Bot webhooks por slug — quando audit entry crítica, notifica bot do cliente.
// Configurar via env: BOT_WEBHOOK_ARENA=http://localhost:3110/webhook/alert
// (cada cliente tem seu próprio bot+porta — Arena 3110, Suprema 3111, etc.)
// ──────────────────────────────────────────────────────────────────────────────
const BOT_WEBHOOKS = {
  arena: process.env.BOT_WEBHOOK_ARENA || null,
  suprema: process.env.BOT_WEBHOOK_SUPREMA || null,
};

async function notifyBotIfCritical(entry) {
  const webhook = BOT_WEBHOOKS[entry?.slug];
  if (!webhook) return;
  // Critério crítico: ação resultou em erro, OU foi pause/budget_down (decisão sensível).
  const isCritical =
    entry?.ok === false ||
    entry?.action === 'pause' ||
    entry?.action === 'budget_down';
  if (!isCritical) return;

  const action = entry.action || 'ação';
  const entity = entry.entity_type === 'campaign' ? 'campanha'
               : entry.entity_type === 'adset' ? 'adset'
               : entry.entity_type === 'ad' ? 'criativo' : entity?.entity_type;
  const name = entry.entity_name || entry.entity_id || '?';
  const actor = entry.actor || 'Sistema';

  const payload = entry.ok
    ? {
        severity: 'warning',
        slug: entry.slug,
        title: `${actor} aplicou "${action}" em ${entity}`,
        detail: `Entidade: ${name}`,
      }
    : {
        severity: 'critical',
        slug: entry.slug,
        title: `Falha ao "${action}" em ${entity}`,
        detail: `${actor} tentou ${action} ${name} — erro: ${entry.error || 'desconhecido'}`,
      };

  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 4000);
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(to);
  } catch (e) {
    console.warn('bot webhook failed:', e.message);
  }
}

// Serializa escritas no audit log: cada entrada é encadeada na anterior pra evitar
// corrupção por fs.appendFile concorrente (sem lock).
let auditChain = Promise.resolve();

async function writeAuditEntry(entry) {
  await rotateAuditLogIfNeeded();
  const enriched = {
    ts: new Date().toISOString(),
    actor: entry?.actor || null,
    ...entry,
  };
  const line = JSON.stringify(enriched) + '\n';
  await fs.appendFile(AUDIT_LOG_PATH, line, 'utf-8');
  // Dispara alerta no bot do cliente (best effort, não bloqueia)
  notifyBotIfCritical(enriched).catch(() => {});
}

function logAuditEntry(entry) {
  auditChain = auditChain
    .then(() => writeAuditEntry(entry))
    .catch((e) => { console.warn('audit log append failed:', e.message); });
  return auditChain;
}

async function readAuditLog({ slug, entity_type, limit = 50, since } = {}) {
  try {
    const raw = await fs.readFile(AUDIT_LOG_PATH, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    const lim = Math.min(Math.max(1, Number(limit) || 50), 500);
    const sinceMs = since ? Date.parse(since) : null;
    // Lê de trás pra frente; sai quando passa do `since` ou atinge `limit`.
    const parsed = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i]);
        if (sinceMs != null) {
          const ts = Date.parse(o.ts);
          if (!isNaN(ts) && ts < sinceMs) break;  // ordenado por ts crescente → corta
        }
        if (slug && o.slug !== slug) continue;
        if (entity_type && o.entity_type !== entity_type) continue;
        parsed.push(o);
        if (parsed.length >= lim) break;
      } catch {}
    }
    return { ok: true, entries: parsed };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, entries: [] };
    return { ok: false, error: e.message, entries: [] };
  }
}

async function postEntityAction({ slug, entity_type, entity_id, action, factor }) {
  if (!slug || !entity_type || !entity_id || !action) return { ok: false, error: 'missing_params' };
  if (!['campaign', 'adset', 'ad'].includes(entity_type)) {
    return { ok: false, error: 'entity_type_invalido' };
  }
  const c = await readMappingClient(slug);
  if (!c) return { ok: false, error: 'cliente_nao_encontrado' };
  const token = await readToken();
  if (!token) return { ok: false, error: 'sem_token' };

  // Campos de validação por tipo (todos retornam account_id)
  const fieldsByType = {
    campaign: 'account_id,daily_budget,status',
    adset:    'account_id,campaign_id,status',
    ad:       'account_id,adset_id,campaign_id,status',
  };

  // budget_up/budget_down só funcionam pra campanha
  if ((action === 'budget_up' || action === 'budget_down') && entity_type !== 'campaign') {
    return { ok: false, error: 'budget_action_apenas_campaign' };
  }

  try {
    // 1) Confirma ownership: GET na entidade e compara account_id com o do slug
    const checkUrl = `https://graph.facebook.com/v23.0/${entity_id}?fields=${fieldsByType[entity_type]}&access_token=${token}`;
    const cr = await fetch(checkUrl);
    const cj = await cr.json();
    if (cj.error) return { ok: false, error: cj.error.message };
    if (String(cj.account_id) !== String(c.ad_account_id)) {
      return { ok: false, error: `${entity_type} não pertence a ${slug} (conta ${cj.account_id} vs ${c.ad_account_id})` };
    }

    // 2) Monta body do POST de atualização
    let body = '';
    if (action === 'pause') body = `status=PAUSED&access_token=${token}`;
    else if (action === 'resume') body = `status=ACTIVE&access_token=${token}`;
    else if (action === 'budget_up' || action === 'budget_down') {
      const curr = cj.daily_budget ? Number(cj.daily_budget) : null;
      if (!curr) return { ok: false, error: 'sem_daily_budget' };
      const fct = factor && factor > 0 ? factor : (action === 'budget_up' ? 1.2 : 0.8);
      const next = Math.max(100, Math.round(curr * fct)); // mínimo 100 cents
      body = `daily_budget=${next}&access_token=${token}`;
    } else {
      return { ok: false, error: 'action_invalida' };
    }

    const url = `https://graph.facebook.com/v23.0/${entity_id}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const j = await r.json();
    if (j.error) return { ok: false, error: j.error.message };
    // invalida caches afetadas
    insightsCache = {};
    campaignsCache = {};
    adsCache = {};
    return { ok: true, result: j };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Wrapper que faz audit log de cada chamada (sucesso ou erro).
// Mantém entity_name opcional pra log mais legível.
async function postEntityActionLogged(payload, headers = {}) {
  const result = await postEntityAction(payload);
  // actor: prioridade — body.actor → header X-Actor → null
  const actor =
    (payload && typeof payload.actor === 'string' && payload.actor.trim()) ||
    (headers['x-actor'] && String(headers['x-actor']).trim()) ||
    null;
  await logAuditEntry({
    slug: payload?.slug || null,
    entity_type: payload?.entity_type || null,
    entity_id: payload?.entity_id || payload?.campaign_id || null,
    entity_name: payload?.entity_name || null,
    action: payload?.action || null,
    factor: payload?.factor || null,
    actor,
    ok: result.ok,
    error: result.error || null,
  });
  return result;
}

// Retrocompat: payload antigo { slug, campaign_id, action } → mapeia pra novo formato
async function postCampaignAction(payload, headers = {}) {
  if (payload && payload.campaign_id && !payload.entity_id) {
    return postEntityActionLogged({
      slug: payload.slug,
      entity_type: 'campaign',
      entity_id: payload.campaign_id,
      action: payload.action,
      factor: payload.factor,
      entity_name: payload.entity_name,
      actor: payload.actor,
    }, headers);
  }
  return postEntityActionLogged(payload || {}, headers);
}

// Isolamento por subdomínio de cliente (X-Client-Slug injetado pelo nginx de cada
// portal). scopeClients filtra a lista agregada para só aquele cliente; a central
// (admin) não envia o header e continua vendo todos.
function clientSlugLock(req) {
  const s = req.headers['x-client-slug'];
  return (typeof s === 'string' && s.trim()) ? s.trim() : null;
}
function scopeClients(req, data) {
  const lock = clientSlugLock(req);
  if (lock && data && Array.isArray(data.clients)) {
    return { ...data, clients: data.clients.filter((c) => c && c.slug === lock) };
  }
  return data;
}

const server = http.createServer(async (req, res) => {
  try {
    // Lock de slug por portal: força rotas /api/* ao cliente do subdomínio.
    {
      const __lock = clientSlugLock(req);
      if (__lock && req.url.startsWith('/api/')) {
        const __u = new URL(req.url, 'http://x');
        if (__u.searchParams.get('slug') && __u.searchParams.get('slug') !== __lock) {
          __u.searchParams.set('slug', __lock);
          req.url = __u.pathname + '?' + __u.searchParams.toString();
        }
      }
    }
    // Área admin (Basic Auth) — protege HTML e JSON
    if (req.url.startsWith('/admin') || req.url.startsWith('/api/admin')) {
      if (!requireAdminAuth(req, res)) return;
    }

    // === AGENDADOR SOCIAL (F1) — additivo, isolado ===
    if (req.url.startsWith('/api/social')) {
      return routeSocial(req, res, { supabase, readJson, logAuditEntry });
    }

    if (req.url === '/api/admin/status' || req.url.startsWith('/api/admin/status?')) {
      const force = req.url.includes('force=1');
      if (force) adminCache = { data: null, ts: 0 };
      const data = await fetchAdminStatus();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify(scopeClients(req, data), null, 2));
      return;
    }

    if (req.url === '/api/clients' || req.url.startsWith('/api/clients?')) {
      const force = req.url.includes('force=1');
      if (force) clientsCache = { data: null, ts: 0 };
      const data = await fetchPublicClients();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(scopeClients(req, data), null, 2));
      return;
    }

    if (req.url === '/api/agendamentos' || req.url.startsWith('/api/agendamentos?')) {
      const force = req.url.includes('force=1');
      if (force) cache = { data: null, ts: 0 };
      const data = await fetchAgendamentos();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(scopeClients(req, data), null, 2));
      return;
    }

    if (req.url === '/api/renovacao' || req.url.startsWith('/api/renovacao?')) {
      const data = await fetchRenovacao();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(scopeClients(req, data), null, 2));
      return;
    }

    if (req.url === '/api/saldo' || req.url.startsWith('/api/saldo?')) {
      const u = new URL(req.url, 'http://x');
      if (!(await guardRead(req, res, u.searchParams.get('slug') || null))) return;
      const force = req.url.includes('force=1');
      if (force) saldoCache = { data: null, ts: 0 };
      const data = await fetchSaldos();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(scopeClients(req, data), null, 2));
      return;
    }

    if (req.url === '/api/insights' || req.url.startsWith('/api/insights?')) {
      const u = new URL(req.url, 'http://x');
      if (!(await guardRead(req, res, u.searchParams.get('slug') || null))) return;
      if (u.searchParams.get('force') === '1') insightsCache = {};
      const data = await fetchInsights({
        since: u.searchParams.get('since') || undefined,
        until: u.searchParams.get('until') || undefined,
        preset: u.searchParams.get('preset') || undefined,
      });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(scopeClients(req, data), null, 2));
      return;
    }

    if (req.url.startsWith('/api/timeseries')) {
      const u = new URL(req.url, 'http://x');
      if (!(await guardRead(req, res, u.searchParams.get('slug') || null))) return;
      const data = await fetchTimeseries({
        slug: u.searchParams.get('slug') || undefined,
        since: u.searchParams.get('since') || undefined,
        until: u.searchParams.get('until') || undefined,
        preset: u.searchParams.get('preset') || undefined,
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(scopeClients(req, data), null, 2));
      return;
    }

    if (req.url.startsWith('/api/campaigns')) {
      const u = new URL(req.url, 'http://x');
      if (!(await guardRead(req, res, u.searchParams.get('slug') || null))) return;
      const data = await fetchCampaigns({
        slug: u.searchParams.get('slug') || undefined,
        since: u.searchParams.get('since') || undefined,
        until: u.searchParams.get('until') || undefined,
        preset: u.searchParams.get('preset') || undefined,
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(scopeClients(req, data), null, 2));
      return;
    }

    if (req.url.startsWith('/api/ads')) {
      const u = new URL(req.url, 'http://x');
      if (!(await guardRead(req, res, u.searchParams.get('slug') || null))) return;
      const data = await fetchAds({
        slug: u.searchParams.get('slug') || undefined,
        since: u.searchParams.get('since') || undefined,
        until: u.searchParams.get('until') || undefined,
        preset: u.searchParams.get('preset') || undefined,
        campaign_id: u.searchParams.get('campaign_id') || undefined,
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(scopeClients(req, data), null, 2));
      return;
    }

    if (req.url.startsWith('/api/campaign/action') && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let payload = {};
      try { payload = JSON.parse(body); } catch {}

      const actionHeaders = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      };

      // === RBAC server-side (obrigatório) ===
      const actor = await getActorFromJwt(req);
      if (!actor) {
        res.writeHead(401, actionHeaders);
        res.end(JSON.stringify({ ok: false, error: 'auth_required' }, null, 2));
        return;
      }
      const action = payload?.action || null;
      const bodySlug = payload?.slug || null;
      const isAdmin = actor.role === 'admin_fenice';

      if (action === 'budget_up' || action === 'budget_down') {
        // Escalada de budget: SÓ admin_fenice.
        if (!isAdmin) {
          res.writeHead(403, actionHeaders);
          res.end(JSON.stringify({ ok: false, error: 'escalada_requer_admin' }, null, 2));
          return;
        }
      } else if (action === 'pause' || action === 'resume') {
        // admin_fenice OU cliente dono do slug.
        const allowed = isAdmin || (actor.role === 'cliente' && bodySlug && bodySlug === actor.clienteSlug);
        if (!allowed) {
          res.writeHead(403, actionHeaders);
          res.end(JSON.stringify({ ok: false, error: 'sem_acesso_ao_slug' }, null, 2));
          return;
        }
      }

      const result = await postCampaignAction(payload, req.headers);
      res.writeHead(result.ok ? 200 : 400, actionHeaders);
      res.end(JSON.stringify(result, null, 2));
      return;
    }
    if (req.url.startsWith('/api/campaign/action') && req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    if (req.url.startsWith('/api/audit-log')) {
      const u = new URL(req.url, 'http://x');
      const data = await readAuditLog({
        slug: u.searchParams.get('slug') || undefined,
        entity_type: u.searchParams.get('entity_type') || undefined,
        limit: u.searchParams.get('limit') || undefined,
        since: u.searchParams.get('since') || undefined,
      });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(scopeClients(req, data), null, 2));
      return;
    }

    // === CALENDÁRIO SOCIAL — posts publicados do IG (leitura Graph). Dados públicos; auth na camada do portal/proxy. ===
    if (req.url.startsWith('/api/calendar/published')) {
      const u = new URL(req.url, 'http://x');
      const slug = u.searchParams.get('slug') || 'arena';
      const calHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' };
      try {
        const mapping = await loadMapping();
        const client = (mapping.clients || []).find(c => c.slug === slug);
        if (!client || !client.ig_business_id) {
          res.writeHead(404, calHeaders);
          res.end(JSON.stringify({ ok: false, error: 'cliente_sem_ig', slug }, null, 2));
          return;
        }
        const token = await readToken();
        const limit = Math.min(parseInt(u.searchParams.get('limit') || '25', 10) || 25, 50);
        const fields = 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count';
        const api = `https://graph.facebook.com/v23.0/${client.ig_business_id}/media?fields=${fields}&limit=${limit}&access_token=${token}`;
        const gr = await fetch(api);
        const gj = await gr.json();
        if (gj.error) {
          res.writeHead(502, calHeaders);
          res.end(JSON.stringify({ ok: false, error: 'graph_error', detail: gj.error.message }, null, 2));
          return;
        }
        const posts = (gj.data || []).map(m => ({
          id: m.id,
          formato: m.media_product_type === 'REELS' ? 'reel' : (m.media_product_type === 'STORY' ? 'story' : (m.media_type === 'CAROUSEL_ALBUM' ? 'carrossel' : 'feed')),
          media_type: m.media_type,
          legenda: m.caption || '',
          thumb: m.thumbnail_url || m.media_url || '',
          media_url: m.media_url || '',
          permalink: m.permalink || '',
          timestamp: m.timestamp || '',
          likes: m.like_count ?? null,
          comentarios: m.comments_count ?? null,
        }));
        res.writeHead(200, calHeaders);
        res.end(JSON.stringify({ ok: true, slug, ig_username: client.ig_username || null, count: posts.length, posts }, null, 2));
      } catch (e) {
        res.writeHead(500, calHeaders);
        res.end(JSON.stringify({ ok: false, error: 'exception', detail: String((e && e.message) || e) }, null, 2));
      }
      return;
    }

    // === CRIATIVOS HD (auto) — endpoint /api/ad-detail ===
    if (req.url.startsWith('/api/ad-detail')) {
      const u = new URL(req.url, 'http://x');
      // Guard de RBAC no ROTEADOR (criativos-hd.mjs não é tocado).
      if (!(await guardRead(req, res, u.searchParams.get('slug') || null))) return;
      await handleAdDetail(req, res, u.searchParams);
      return;
    }

    // === WIZARD CAMPANHAS (auto) ===
    if (req.method === 'OPTIONS' && (
      req.url.startsWith('/api/campaign/') ||
      req.url.startsWith('/api/creative/') ||
      req.url.startsWith('/api/audience/') ||
      req.url.startsWith('/api/battle/')
    )) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }
    if (req.method === 'POST' && req.url === '/api/campaign/draft') {
      const body = await readJson(req);
      const mapping = await loadMapping();
      return handleDraftSave(req, res, body, { supabase, logAuditEntry, notifyBotIfCritical, mapping, readToken });
    }
    if (req.method === 'GET' && (req.url === '/api/campaign/drafts' || req.url.startsWith('/api/campaign/drafts?'))) {
      const u = new URL(req.url, 'http://x');
      return handleDraftsList(req, res, u.searchParams, { supabase, logAuditEntry, notifyBotIfCritical, readToken });
    }
    if (req.method === 'GET' && /^\/api\/campaign\/draft\/[^/?]+/.test(req.url)) {
      const m = req.url.match(/^\/api\/campaign\/draft\/([^/?]+)/);
      const id = m ? decodeURIComponent(m[1]) : null;
      return handleDraftGet(req, res, id, { supabase, logAuditEntry, notifyBotIfCritical, readToken });
    }
    if (req.method === 'POST' && req.url === '/api/campaign/submit') {
      const body = await readJson(req);
      return handleSubmit(req, res, body, { supabase, logAuditEntry, notifyBotIfCritical, readToken });
    }
    if (req.method === 'POST' && req.url === '/api/campaign/approve') {
      const body = await readJson(req);
      const mapping = await loadMapping();
      return handleApprove(req, res, body, { supabase, logAuditEntry, notifyBotIfCritical, mapping, readToken });
    }
    if (req.method === 'POST' && req.url === '/api/campaign/reject') {
      const body = await readJson(req);
      return handleReject(req, res, body, { supabase, logAuditEntry, notifyBotIfCritical, readToken });
    }
    if (req.method === 'POST' && req.url === '/api/creative/upload') {
      const raw = await readRawBody(req);
      const mapping = await loadMapping();
      return handleCreativeUpload(req, res, raw, req.headers['content-type'] || '', { supabase, logAuditEntry, notifyBotIfCritical, mapping, readToken });
    }
    if (req.method === 'GET' && (req.url === '/api/audience/estimate' || req.url.startsWith('/api/audience/estimate?'))) {
      const u = new URL(req.url, 'http://x');
      const mapping = await loadMapping();
      return handleAudienceEstimate(req, res, u.searchParams, { supabase, logAuditEntry, notifyBotIfCritical, mapping, readToken });
    }

    // === BATTLE MODE (auto) ===
    if (req.method === 'POST' && req.url === '/api/battle/create') {
      const body = await readJson(req);
      const mapping = await loadMapping();
      return handleBattleCreate(req, res, body, { supabase, mapping, logAuditEntry, notifyBotIfCritical, readToken });
    }
    if (req.method === 'GET' && (req.url === '/api/battle/list' || req.url.startsWith('/api/battle/list?'))) {
      const u = new URL(req.url, 'http://x');
      return handleBattleList(req, res, u.searchParams, { supabase });
    }
    {
      const battleMatch = req.url.match(/^\/api\/battle\/([0-9a-f-]{8,})(\/(cancel|decidir|revert))?(\?.*)?$/);
      if (battleMatch) {
        const battleId = battleMatch[1];
        const action = battleMatch[3];
        const mapping = await loadMapping();
        if (req.method === 'GET' && !action) {
          return handleBattleGet(req, res, battleId, { supabase, mapping, readToken });
        }
        if (req.method === 'POST' && action === 'cancel') {
          const body = await readJson(req);
          return handleBattleCancel(req, res, battleId, body, { supabase, logAuditEntry, notifyBotIfCritical });
        }
        if (req.method === 'POST' && action === 'decidir') {
          const body = await readJson(req);
          return handleBattleDecidir(req, res, battleId, body, { supabase, mapping, logAuditEntry, notifyBotIfCritical, readToken });
        }
        if (req.method === 'POST' && action === 'revert') {
          const body = await readJson(req);
          return handleBattleRevert(req, res, battleId, body, { supabase, mapping, logAuditEntry, notifyBotIfCritical, readToken });
        }
      }
    }
    if (req.method === 'POST' && req.url === '/api/battle/cron/run') {
      const mapping = await loadMapping();
      const r = await runBattleCron({ supabase, mapping, logAuditEntry, notifyBotIfCritical, readToken }).catch((e) => ({ ok: false, error: e.message }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(r, null, 2));
    }

    if (req.url.startsWith('/api/breakdown')) {
      const u = new URL(req.url, 'http://x');
      if (!(await guardRead(req, res, u.searchParams.get('slug') || null))) return;
      const data = await fetchBreakdown({
        slug: u.searchParams.get('slug') || undefined,
        breakdowns: u.searchParams.get('breakdowns') || undefined,
        since: u.searchParams.get('since') || undefined,
        until: u.searchParams.get('until') || undefined,
        preset: u.searchParams.get('preset') || undefined,
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(scopeClients(req, data), null, 2));
      return;
    }

    const resolved = resolveFilePath(req.url);
    if (!resolved) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const data = await fs.readFile(resolved.filePath);
    const ext = path.extname(resolved.filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404).end('404 - Not Found: ' + req.url);
    } else {
      console.error(err);
      res.writeHead(500).end('500 - Server Error');
    }
  }
});

// === BATTLE MODE CRON (auto) — roda a cada 6h, primeira após 60s do startup ===
if (supabase) {
  const BATTLE_CRON_INTERVAL_MS = 6 * 3600 * 1000;
  setTimeout(async () => {
    const mapping = await loadMapping();
    runBattleCron({ supabase, mapping, logAuditEntry, notifyBotIfCritical, readToken }).catch((e) => console.error('[battle-cron] erro:', e.message));
  }, 60_000);
  setInterval(async () => {
    const mapping = await loadMapping();
    runBattleCron({ supabase, mapping, logAuditEntry, notifyBotIfCritical, readToken }).catch((e) => console.error('[battle-cron] erro:', e.message));
  }, BATTLE_CRON_INTERVAL_MS);
  console.log('[battle-cron] agendado a cada 6h');
}

// === AGENDADOR SOCIAL CRON (F1 / DRY-RUN) — roda a cada 60s ===
if (supabase) {
  setInterval(() => {
    runSocialCron({ supabase, logAuditEntry }).catch((e) => console.error('[social-cron] erro:', e.message));
  }, 60_000);
  console.log('[social-cron] agendado a cada 60s (DRY-RUN)');
}

server.listen(PORT, '127.0.0.1', () => {
  console.log('━'.repeat(60));
  console.log('📊  Dashboard de Tráfego Pago — Ativo');
  console.log('━'.repeat(60));
  console.log(`   🏠  http://localhost:${PORT}/  (central de dashboards · pública)`);
  console.log(`   📅  http://localhost:${PORT}/agendamentos.html`);
  console.log(`   🔄  http://localhost:${PORT}/renovacao.html`);
  console.log(`   🛡️   http://localhost:${PORT}/admin/  ${ADMIN_USER ? '(Basic Auth ativo)' : '⚠ DESATIVADO — defina ADMIN_USER/ADMIN_PASS'}`);
  console.log(`   🔌  http://localhost:${PORT}/api/clients (público)`);
  console.log(`   🔌  http://localhost:${PORT}/api/agendamentos`);
  console.log(`   🔌  http://localhost:${PORT}/api/renovacao`);
  console.log(`   🔌  http://localhost:${PORT}/api/admin/status`);
  console.log('');
  console.log(`   🔑  Token: ${process.env.META_GRAPH_TOKEN ? 'env var ✓' : `arquivo ${TOKEN_FILE}`}`);
  console.log(`   🗂️  Clients dir: ${CLIENTS_DIR}`);
  if (Object.keys(CLIENT_ALIASES).length) {
    console.log(`   📌  Aliases: ${Object.keys(CLIENT_ALIASES).length} clientes mapeados`);
  }
  console.log('━'.repeat(60));
  console.log('   Ctrl+C para encerrar\n');
});
