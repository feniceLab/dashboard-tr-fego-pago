// ──────────────────────────────────────────────────────────────────────────────
// social-handlers.mjs — AGENDADOR SOCIAL (F1 / MVP)
//
// Módulo NOVO e ISOLADO. Delegado pelo server.mjs via UM bloco
//   if (req.url.startsWith('/api/social')) { return routeSocial(req, res, ctx); }
//
// Reusa os helpers do server.mjs passados via `ctx`:
//   { supabase, readJson, logAuditEntry }
//
// Tabelas: public.social_publicacoes, public.social_midias (Supabase service_role
// → bypassa RLS; ESCOPAMOS manualmente por cliente_slug).
//
// IMPORTANTE: F1 é DRY-RUN. Estes handlers só fazem CRUD no banco. NENHUMA chamada
// de publicação à Graph API acontece aqui (isso é responsabilidade do worker
// social-cron.mjs, que na F1 também é DRY-RUN).
// ──────────────────────────────────────────────────────────────────────────────

'use strict';

import fs from 'node:fs';
import path from 'node:path';

// Enums válidos (espelham os enums do Postgres — validação defensiva server-side)
const PLATAFORMAS = new Set(['instagram', 'facebook']);
const FORMATOS = new Set(['feed', 'reel', 'story', 'carrossel']);
const PILARES = new Set(['produto', 'promocao', 'bastidores', 'prova_social', 'institucional']);
const MIDIA_TIPOS = new Set(['imagem', 'video']);

// Mapa slug-do-serviço (clients-mapping.json / API) → slug-na-tabela-clientes (Supabase).
// F1 só cobre Arena. O serviço usa slug 'arena'; a tabela clientes usa 'arena-gourmet'.
const SLUG_SERVICO_TO_BANCO = {
  arena: 'arena-gourmet',
  suprema: 'suprema-pizza',
  oca: 'oca-restaurante',
  imperio: 'imperio-do-sabor',
};

// Cache simples de resolução slug → { cliente_id, cliente_slug } (curto, evita
// roundtrip a cada request). cliente_slug guardado é SEMPRE o slug do serviço.
const _clienteCache = new Map();

// ──────────────────────────────────────────────────────────────────────────────
// SELETOR VISUAL DE MÍDIAS DO CRONOGRAMA
// Escaneia a pasta do cronograma servida pelo OpenResty e devolve as mídias
// (vídeo + thumbnail) já com URL HTTPS pública. Aditivo e defensivo.
// ──────────────────────────────────────────────────────────────────────────────

// Mapa slug-do-serviço → { dominio, cronogramaDir }. Por enquanto só Arena.
const MEDIA_SLUG_CONFIG = {
  arena: {
    dominio: 'arenagourmet.fenicelab.com.br',
    siteRoot: '/etc/icontainer/apps/openresty/openresty/www/sites/arenagourmet.fenicelab.com.br',
    cronogramaRel: 'Arena/ui_kits/cronograma/assets',
  },
};

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.m4v']);

// Escaneia stories/<dia>/<slug>.<ext>; casa o thumb de mesmo basename em
// thumbs/<dia>/. Devolve lista achatada com URLs públicas.
function scanCronograma(cfg) {
  const out = [];
  const storiesDir = path.join(cfg.siteRoot, cfg.cronogramaRel, 'stories');
  const thumbsDir = path.join(cfg.siteRoot, cfg.cronogramaRel, 'thumbs');
  const baseUrl = `https://${cfg.dominio}/${cfg.cronogramaRel}`;

  let dias = [];
  try {
    dias = fs.readdirSync(storiesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out; // pasta inexistente → lista vazia
  }

  for (const dia of dias) {
    let arquivos = [];
    try {
      arquivos = fs.readdirSync(path.join(storiesDir, dia), { withFileTypes: true })
        .filter((f) => f.isFile())
        .map((f) => f.name);
    } catch {
      continue;
    }
    for (const arq of arquivos) {
      const ext = path.extname(arq).toLowerCase();
      if (!VIDEO_EXTS.has(ext)) continue;
      const slug = path.basename(arq, ext);

      // Procura thumb de mesmo basename (qualquer extensão de imagem).
      let thumbUrl = null;
      try {
        const thumbsDoDia = fs.readdirSync(path.join(thumbsDir, dia));
        const match = thumbsDoDia.find((t) => path.basename(t, path.extname(t)) === slug);
        if (match) thumbUrl = `${baseUrl}/thumbs/${dia}/${encodeURIComponent(match)}`;
      } catch { /* sem thumbs nesse dia → segue sem thumb */ }

      out.push({
        nome: slug,
        dia,
        tipo: 'video',
        url: `${baseUrl}/stories/${dia}/${encodeURIComponent(arq)}`,
        thumb: thumbUrl,
      });
    }
  }

  // Ordem estável por dia da semana e depois por nome.
  const ordemDia = { segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6, domingo: 7 };
  out.sort((a, b) => {
    const da = ordemDia[a.dia] ?? 99, db = ordemDia[b.dia] ?? 99;
    if (da !== db) return da - db;
    return a.nome.localeCompare(b.nome);
  });
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/social/media?slug=arena
// ──────────────────────────────────────────────────────────────────────────────
function handleMediaList(req, res, params) {
  const slug = (params.get('slug') || '').trim();
  if (!slug) return sendJson(res, 400, { ok: false, error: 'slug_obrigatorio' });

  const cfg = MEDIA_SLUG_CONFIG[slug];
  if (!cfg) return sendJson(res, 200, { ok: true, slug, count: 0, midias: [] });

  let midias = [];
  try {
    midias = scanCronograma(cfg);
  } catch {
    midias = [];
  }
  return sendJson(res, 200, { ok: true, slug, count: midias.length, midias });
}

function sendJson(res, code, payload) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(payload, null, 2));
}

// Resolve o cliente_id do banco a partir do slug do serviço (ex: 'arena').
// Retorna { cliente_id, cliente_slug } onde cliente_slug é o slug do SERVIÇO
// (o que escopa social_publicacoes), ou null se não encontrado.
async function resolveCliente(supabase, slugServico) {
  if (!slugServico) return null;
  if (_clienteCache.has(slugServico)) return _clienteCache.get(slugServico);
  const slugBanco = SLUG_SERVICO_TO_BANCO[slugServico] || slugServico;
  const { data, error } = await supabase
    .from('clientes')
    .select('id, slug')
    .eq('slug', slugBanco)
    .maybeSingle();
  if (error || !data) return null;
  const resolved = { cliente_id: data.id, cliente_slug: slugServico };
  _clienteCache.set(slugServico, resolved);
  return resolved;
}

// Monta o SELECT base de uma publicação derivando data/hora/dia_semana no fuso.
const POSTS_SELECT = `
  id, plataforma, formato, pilar, legenda, agendado_para, fuso, status,
  recorrente, permalink, media_id, tentativas, ultimo_erro,
  to_char(agendado_para AT TIME ZONE fuso, 'YYYY-MM-DD') AS data,
  to_char(agendado_para AT TIME ZONE fuso, 'HH24:MI')    AS hora,
  to_char(agendado_para AT TIME ZONE fuso, 'TMDay')      AS dia_semana
`;

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/social?slug=&from=&to=
// ──────────────────────────────────────────────────────────────────────────────
async function handleList(req, res, params, ctx) {
  const { supabase } = ctx;
  const slug = (params.get('slug') || '').trim();
  if (!slug) return sendJson(res, 400, { ok: false, error: 'slug_obrigatorio' });

  const cli = await resolveCliente(supabase, slug);
  if (!cli) return sendJson(res, 404, { ok: false, error: 'cliente_nao_encontrado', slug });

  const from = (params.get('from') || '').trim(); // YYYY-MM-DD
  const to = (params.get('to') || '').trim();     // YYYY-MM-DD

  // Usa RPC-less SQL via supabase: filtro por intervalo no campo agendado_para.
  // Como precisamos de to_char com AT TIME ZONE, usamos uma view inline via
  // PostgREST não dá — então fazemos a derivação no JS a partir de agendado_para.
  let q = supabase
    .from('social_publicacoes')
    .select(`
      id, plataforma, formato, pilar, legenda, agendado_para, fuso, status,
      recorrente, permalink, media_id, tentativas, ultimo_erro,
      social_midias ( ordem, tipo, media_url )
    `)
    .eq('cliente_slug', slug)
    .order('agendado_para', { ascending: true });

  if (from) q = q.gte('agendado_para', `${from}T00:00:00`);
  if (to) q = q.lte('agendado_para', `${to}T23:59:59`);

  const { data, error } = await q;
  if (error) return sendJson(res, 500, { ok: false, error: 'db_error', detail: error.message });

  const DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const posts = (data || []).map((p) => {
    let dataStr = null, hora = null, dia_semana = null;
    if (p.agendado_para) {
      // Deriva data/hora/dia_semana no fuso do post (default America/Sao_Paulo).
      const fuso = p.fuso || 'America/Sao_Paulo';
      try {
        const d = new Date(p.agendado_para);
        const fmt = new Intl.DateTimeFormat('pt-BR', {
          timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', weekday: 'long', hour12: false,
        });
        const parts = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
        dataStr = `${parts.year}-${parts.month}-${parts.day}`;
        hora = `${parts.hour}:${parts.minute}`;
        // weekday em pt-BR já vem por extenso; usa o array p/ consistência via getDay no fuso
        dia_semana = parts.weekday;
      } catch {
        dataStr = p.agendado_para.slice(0, 10);
        hora = p.agendado_para.slice(11, 16);
      }
    }
    const midias = (p.social_midias || [])
      .slice()
      .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0))
      .map((m) => ({ ordem: m.ordem, tipo: m.tipo, media_url: m.media_url }));
    return {
      id: p.id,
      plataforma: p.plataforma,
      formato: p.formato,
      pilar: p.pilar,
      legenda: p.legenda,
      agendado_para: p.agendado_para,
      fuso: p.fuso,
      status: p.status,
      recorrente: p.recorrente,
      data: dataStr,
      hora,
      dia_semana,
      permalink: p.permalink,
      media_id: p.media_id,
      tentativas: p.tentativas,
      ultimo_erro: p.ultimo_erro,
      midias,
    };
  });

  return sendJson(res, 200, { ok: true, slug, count: posts.length, posts });
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/social  { slug, plataforma, formato, pilar?, legenda, agendado_para,
//                     recorrente?, midias?:[{tipo,media_url,ordem}] }
// ──────────────────────────────────────────────────────────────────────────────
async function handleCreate(req, res, ctx) {
  const { supabase, readJson, logAuditEntry } = ctx;
  const body = await readJson(req);

  const slug = (body.slug || '').trim();
  if (!slug) return sendJson(res, 400, { ok: false, error: 'slug_obrigatorio' });

  const cli = await resolveCliente(supabase, slug);
  if (!cli) return sendJson(res, 404, { ok: false, error: 'cliente_nao_encontrado', slug });

  const plataforma = (body.plataforma || '').trim();
  const formato = (body.formato || '').trim();
  if (!PLATAFORMAS.has(plataforma)) return sendJson(res, 400, { ok: false, error: 'plataforma_invalida' });
  if (!FORMATOS.has(formato)) return sendJson(res, 400, { ok: false, error: 'formato_invalido' });

  let pilar = body.pilar ? String(body.pilar).trim() : null;
  if (pilar && !PILARES.has(pilar)) return sendJson(res, 400, { ok: false, error: 'pilar_invalido' });

  const agendado_para = body.agendado_para ? String(body.agendado_para).trim() : null;
  const fuso = body.fuso ? String(body.fuso).trim() : 'America/Sao_Paulo';

  // status: 'agendado' SE houver agendado_para futuro; senão 'rascunho'.
  let status = 'rascunho';
  if (agendado_para) {
    const when = Date.parse(agendado_para);
    if (isNaN(when)) return sendJson(res, 400, { ok: false, error: 'agendado_para_invalido' });
    if (when <= Date.now()) return sendJson(res, 400, { ok: false, error: 'agendado_para_deve_ser_futuro' });
    status = 'agendado';
  }

  const midias = Array.isArray(body.midias) ? body.midias : [];
  for (const m of midias) {
    if (!MIDIA_TIPOS.has((m?.tipo || '').trim())) {
      return sendJson(res, 400, { ok: false, error: 'midia_tipo_invalido' });
    }
    if (!m?.media_url || typeof m.media_url !== 'string') {
      return sendJson(res, 400, { ok: false, error: 'midia_url_obrigatoria' });
    }
  }

  const { data: inserted, error: insErr } = await supabase
    .from('social_publicacoes')
    .insert({
      cliente_id: cli.cliente_id,
      cliente_slug: slug,
      plataforma,
      formato,
      pilar,
      legenda: body.legenda ?? null,
      agendado_para,
      fuso,
      status,
      recorrente: body.recorrente === true,
    })
    .select('id, status')
    .single();

  if (insErr) return sendJson(res, 500, { ok: false, error: 'db_error', detail: insErr.message });

  if (midias.length) {
    const rows = midias.map((m, i) => ({
      publicacao_id: inserted.id,
      cliente_id: cli.cliente_id,
      ordem: Number.isInteger(m.ordem) ? m.ordem : i,
      tipo: m.tipo,
      media_url: m.media_url,
      status_processamento: 'pronto', // F1: mídia por URL já pública
    }));
    const { error: midErr } = await supabase.from('social_midias').insert(rows);
    if (midErr) {
      // rollback best-effort da publicação pra não deixar órfã
      await supabase.from('social_publicacoes').delete().eq('id', inserted.id);
      return sendJson(res, 500, { ok: false, error: 'db_error_midias', detail: midErr.message });
    }
  }

  try { logAuditEntry?.({ slug, action: 'social_create', entity_type: 'social', entity_id: inserted.id, ok: true }); } catch {}
  return sendJson(res, 201, { ok: true, id: inserted.id, status: inserted.status });
}

// ──────────────────────────────────────────────────────────────────────────────
// PUT /api/social/:id  { legenda?, agendado_para?, formato?, pilar? }
// ──────────────────────────────────────────────────────────────────────────────
async function handleUpdate(req, res, id, ctx) {
  const { supabase, readJson, logAuditEntry } = ctx;
  const body = await readJson(req);

  const { data: current, error: getErr } = await supabase
    .from('social_publicacoes')
    .select('id, status, cliente_slug')
    .eq('id', id)
    .maybeSingle();
  if (getErr) return sendJson(res, 500, { ok: false, error: 'db_error', detail: getErr.message });
  if (!current) return sendJson(res, 404, { ok: false, error: 'nao_encontrado' });
  if (['publicando', 'publicado'].includes(current.status)) {
    return sendJson(res, 409, { ok: false, error: 'status_imutavel', status: current.status });
  }

  const patch = {};
  if (body.legenda !== undefined) patch.legenda = body.legenda;
  if (body.formato !== undefined) {
    const f = String(body.formato).trim();
    if (!FORMATOS.has(f)) return sendJson(res, 400, { ok: false, error: 'formato_invalido' });
    patch.formato = f;
  }
  if (body.pilar !== undefined) {
    const p = body.pilar ? String(body.pilar).trim() : null;
    if (p && !PILARES.has(p)) return sendJson(res, 400, { ok: false, error: 'pilar_invalido' });
    patch.pilar = p;
  }
  if (body.agendado_para !== undefined) {
    if (body.agendado_para === null) {
      patch.agendado_para = null;
      if (current.status === 'agendado') patch.status = 'rascunho';
    } else {
      const when = Date.parse(String(body.agendado_para));
      if (isNaN(when)) return sendJson(res, 400, { ok: false, error: 'agendado_para_invalido' });
      if (when <= Date.now()) return sendJson(res, 400, { ok: false, error: 'agendado_para_deve_ser_futuro' });
      patch.agendado_para = String(body.agendado_para).trim();
      if (current.status === 'rascunho') patch.status = 'agendado';
    }
  }

  if (Object.keys(patch).length === 0) {
    return sendJson(res, 400, { ok: false, error: 'nada_para_atualizar' });
  }
  patch.updated_at = new Date().toISOString();

  const { data: updated, error: updErr } = await supabase
    .from('social_publicacoes')
    .update(patch)
    .eq('id', id)
    .select('id, status')
    .single();
  if (updErr) return sendJson(res, 500, { ok: false, error: 'db_error', detail: updErr.message });

  try { logAuditEntry?.({ slug: current.cliente_slug, action: 'social_update', entity_type: 'social', entity_id: id, ok: true }); } catch {}
  return sendJson(res, 200, { ok: true, id: updated.id, status: updated.status });
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/social/:id/cancel
// ──────────────────────────────────────────────────────────────────────────────
async function handleCancel(req, res, id, ctx) {
  const { supabase, logAuditEntry } = ctx;
  const { data: current, error: getErr } = await supabase
    .from('social_publicacoes')
    .select('id, status, cliente_slug')
    .eq('id', id)
    .maybeSingle();
  if (getErr) return sendJson(res, 500, { ok: false, error: 'db_error', detail: getErr.message });
  if (!current) return sendJson(res, 404, { ok: false, error: 'nao_encontrado' });
  if (['publicando', 'publicado'].includes(current.status)) {
    return sendJson(res, 409, { ok: false, error: 'status_imutavel', status: current.status });
  }

  const { error: updErr } = await supabase
    .from('social_publicacoes')
    .update({ status: 'cancelado', updated_at: new Date().toISOString() })
    .eq('id', id);
  if (updErr) return sendJson(res, 500, { ok: false, error: 'db_error', detail: updErr.message });

  try { logAuditEntry?.({ slug: current.cliente_slug, action: 'social_cancel', entity_type: 'social', entity_id: id, ok: true }); } catch {}
  return sendJson(res, 200, { ok: true, id, status: 'cancelado' });
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/social/:id/approve
// F1: criado_por/aprovado_por ficam null (sem auth de usuário fácil nesta fase).
// ──────────────────────────────────────────────────────────────────────────────
async function handleApprove(req, res, id, ctx) {
  const { supabase, logAuditEntry } = ctx;
  const { data: current, error: getErr } = await supabase
    .from('social_publicacoes')
    .select('id, status, cliente_slug')
    .eq('id', id)
    .maybeSingle();
  if (getErr) return sendJson(res, 500, { ok: false, error: 'db_error', detail: getErr.message });
  if (!current) return sendJson(res, 404, { ok: false, error: 'nao_encontrado' });
  if (['publicando', 'publicado', 'cancelado'].includes(current.status)) {
    return sendJson(res, 409, { ok: false, error: 'status_imutavel', status: current.status });
  }

  const { error: updErr } = await supabase
    .from('social_publicacoes')
    .update({ status: 'aprovado', aprovado_em: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id);
  if (updErr) return sendJson(res, 500, { ok: false, error: 'db_error', detail: updErr.message });

  try { logAuditEntry?.({ slug: current.cliente_slug, action: 'social_approve', entity_type: 'social', entity_id: id, ok: true }); } catch {}
  return sendJson(res, 200, { ok: true, id, status: 'aprovado' });
}

// ──────────────────────────────────────────────────────────────────────────────
// Roteador — delegado pelo server.mjs
// ──────────────────────────────────────────────────────────────────────────────
async function routeSocial(req, res, ctx) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  const u = new URL(req.url, 'http://x');
  const pathOnly = u.pathname;

  // /api/social/media  (GET) — seletor visual de mídias do cronograma.
  // NÃO depende do Supabase (lê o filesystem) → resolvido antes do guard.
  if (pathOnly === '/api/social/media' && req.method === 'GET') {
    return handleMediaList(req, res, u.searchParams);
  }

  // Daqui pra frente tudo precisa do Supabase.
  if (!ctx?.supabase) return sendJson(res, 503, { ok: false, error: 'supabase_indisponivel' });

  // /api/social/:id/(cancel|approve)
  const actionMatch = pathOnly.match(/^\/api\/social\/([0-9a-fA-F-]{8,})\/(cancel|approve)$/);
  if (actionMatch && req.method === 'POST') {
    const id = actionMatch[1];
    if (actionMatch[2] === 'cancel') return handleCancel(req, res, id, ctx);
    if (actionMatch[2] === 'approve') return handleApprove(req, res, id, ctx);
  }

  // /api/social/:id  (PUT)
  const idMatch = pathOnly.match(/^\/api\/social\/([0-9a-fA-F-]{8,})$/);
  if (idMatch && req.method === 'PUT') {
    return handleUpdate(req, res, idMatch[1], ctx);
  }

  // /api/social  (GET list | POST create)
  if (pathOnly === '/api/social') {
    if (req.method === 'GET') return handleList(req, res, u.searchParams, ctx);
    if (req.method === 'POST') return handleCreate(req, res, ctx);
  }

  return sendJson(res, 404, { ok: false, error: 'rota_social_desconhecida', path: pathOnly, method: req.method });
}

export { routeSocial };
