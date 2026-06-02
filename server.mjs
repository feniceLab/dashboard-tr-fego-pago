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

const server = http.createServer(async (req, res) => {
  try {
    // Área admin (Basic Auth) — protege HTML e JSON
    if (req.url.startsWith('/admin') || req.url.startsWith('/api/admin')) {
      if (!requireAdminAuth(req, res)) return;
    }

    if (req.url === '/api/admin/status' || req.url.startsWith('/api/admin/status?')) {
      const force = req.url.includes('force=1');
      if (force) adminCache = { data: null, ts: 0 };
      const data = await fetchAdminStatus();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify(data, null, 2));
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
      res.end(JSON.stringify(data, null, 2));
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
      res.end(JSON.stringify(data, null, 2));
      return;
    }

    if (req.url === '/api/renovacao' || req.url.startsWith('/api/renovacao?')) {
      const data = await fetchRenovacao();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(data, null, 2));
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

server.listen(PORT, () => {
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
