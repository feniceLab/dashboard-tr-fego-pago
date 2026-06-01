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

function resolveFilePath(reqUrl) {
  let urlPath = decodeURIComponent(reqUrl.split('?')[0]);
  // Diretório raiz vira index.html
  if (urlPath === '/') urlPath = '/index.html';
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
  console.log(`   📡  http://localhost:${PORT}`);
  console.log(`   📅  http://localhost:${PORT}/agendamentos.html`);
  console.log(`   🔄  http://localhost:${PORT}/renovacao.html`);
  console.log(`   🔌  http://localhost:${PORT}/api/agendamentos`);
  console.log(`   🔌  http://localhost:${PORT}/api/renovacao`);
  console.log('');
  console.log(`   🔑  Token: ${process.env.META_GRAPH_TOKEN ? 'env var ✓' : `arquivo ${TOKEN_FILE}`}`);
  console.log(`   🗂️  Clients dir: ${CLIENTS_DIR}`);
  if (Object.keys(CLIENT_ALIASES).length) {
    console.log(`   📌  Aliases: ${Object.keys(CLIENT_ALIASES).length} clientes mapeados`);
  }
  console.log('━'.repeat(60));
  console.log('   Ctrl+C para encerrar\n');
});
