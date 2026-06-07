// services/relatorios/wizard-helpers.mjs
// =============================================================================
// Wizard de Campanhas — helpers + handlers
// Roda em conjunto com server.mjs (sem editar server.mjs).
// Recebe `ctx` do server: { supabase, logAuditEntry, notifyBotIfCritical, mapping }
// Mais o readToken (passado via ctx.readToken) e META_API base.
// =============================================================================

const META_API = process.env.META_API || 'https://graph.facebook.com/v23.0';
const TAG = '[wizard]';

// =============================================================================
// HTTP utils — usadas pelos handlers
// =============================================================================

function jsonResp(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(payload, null, 2));
}

function err(res, status, msg, extra = {}) {
  return jsonResp(res, status, { ok: false, error: msg, ...extra });
}

function ok(res, payload = {}) {
  return jsonResp(res, 200, { ok: true, ...payload });
}

// =============================================================================
// Actor / RBAC
// =============================================================================

/**
 * Valida o ator (usuário) pelo auth_id consultando public.usuarios.
 * @param {object} supabase  cliente Supabase (service role)
 * @param {string} authId    UUID do usuário (auth.users.id)
 * @param {string|null} requiredRole  'admin_fenice' | 'cliente' | null (qualquer)
 * @returns {Promise<{ok:boolean, user?:object, error?:string}>}
 */
export async function validateActor(supabase, authId, requiredRole = null) {
  if (!supabase) return { ok: false, error: 'supabase_indisponivel' };
  if (!authId || typeof authId !== 'string') {
    return { ok: false, error: 'auth_id_invalido' };
  }
  try {
    const { data, error } = await supabase
      .from('usuarios')
      .select('id, auth_id, email, role, cliente_slug, nome_exibicao')
      .eq('auth_id', authId)
      .maybeSingle();
    if (error) return { ok: false, error: `usuarios_query: ${error.message}` };
    if (!data) return { ok: false, error: 'usuario_nao_encontrado' };
    if (requiredRole && data.role !== requiredRole) {
      return { ok: false, error: `papel_insuficiente: requer ${requiredRole}` };
    }
    return { ok: true, user: data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Verifica se o ator tem acesso a um slug específico.
 * admin_fenice: acessa tudo. cliente: só o próprio cliente_slug.
 */
function actorCanAccessSlug(user, slug) {
  if (!user) return false;
  if (user.role === 'admin_fenice') return true;
  return user.cliente_slug === slug;
}

// =============================================================================
// Validação de payload do draft
// =============================================================================

const VERTICAIS_VALIDAS = ['delivery', 'servicos', 'ecommerce', 'awareness'];

/**
 * Valida payload de campanha (modo "submeter para aprovação").
 * Para draft salvo, validação é mais frouxa (só checa o que veio).
 * @param {object} payload  payload da campanha (criativo, targeting, etc.)
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateDraftPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object') {
    return { ok: false, errors: ['payload_ausente'] };
  }

  // Criativo
  const c = payload.criativo;
  if (!c || typeof c !== 'object') {
    errors.push('criativo_ausente');
  } else {
    if (!c.tipo || !['image', 'video', 'carousel'].includes(c.tipo)) {
      errors.push('criativo.tipo_invalido (image|video|carousel)');
    }
    if (c.tipo === 'image' && !c.image_hash) errors.push('criativo.image_hash_ausente');
    if (c.tipo === 'video' && !c.video_id) errors.push('criativo.video_id_ausente');
    if (!c.primary_text || String(c.primary_text).trim().length < 5) {
      errors.push('criativo.primary_text_curto (>=5)');
    }
    if (!c.cta || typeof c.cta !== 'string') errors.push('criativo.cta_ausente');
    if (!c.link_destino || !/^https?:\/\//.test(c.link_destino || '')) {
      errors.push('criativo.link_destino_invalido');
    }
  }

  // Targeting
  const t = payload.targeting;
  if (!t || typeof t !== 'object') {
    errors.push('targeting_ausente');
  } else {
    if (!t.geo_locations) errors.push('targeting.geo_locations_ausente');
    if (t.age_min != null && (t.age_min < 13 || t.age_min > 65)) {
      errors.push('targeting.age_min_fora_da_faixa');
    }
    if (t.age_max != null && (t.age_max < 13 || t.age_max > 65)) {
      errors.push('targeting.age_max_fora_da_faixa');
    }
  }

  // Optimization
  if (!payload.optimization_goal) errors.push('optimization_goal_ausente');
  if (!payload.billing_event) errors.push('billing_event_ausente');

  return { ok: errors.length === 0, errors };
}

/**
 * Valida campos top-level do draft (linha em campanhas_draft) na hora de submeter.
 */
function validateDraftRow(row) {
  const errors = [];
  if (!row) return { ok: false, errors: ['row_ausente'] };
  if (!row.slug) errors.push('slug_ausente');
  if (!row.vertical || !VERTICAIS_VALIDAS.includes(row.vertical)) {
    errors.push('vertical_invalido');
  }
  if (!row.objetivo) errors.push('objetivo_ausente');
  if (!row.nome || String(row.nome).trim().length < 3) errors.push('nome_curto');
  if (row.budget_diario_cents == null || row.budget_diario_cents < 3000) {
    errors.push('budget_diario_cents_min_3000');
  }
  if (!row.data_inicio) errors.push('data_inicio_ausente');
  if (!row.data_fim) errors.push('data_fim_ausente');

  if (row.data_inicio) {
    const di = new Date(row.data_inicio + 'T00:00:00Z');
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    if (isNaN(di.getTime())) errors.push('data_inicio_invalida');
    else if (di.getTime() < today.getTime()) errors.push('data_inicio_no_passado');
  }
  if (row.data_inicio && row.data_fim) {
    const di = new Date(row.data_inicio + 'T00:00:00Z').getTime();
    const df = new Date(row.data_fim + 'T00:00:00Z').getTime();
    if (df < di) errors.push('data_fim_antes_de_data_inicio');
  }

  return { ok: errors.length === 0, errors };
}

// =============================================================================
// Meta Graph API — wrappers
// =============================================================================

async function getMetaToken(ctx) {
  if (ctx && typeof ctx.readToken === 'function') {
    return await ctx.readToken();
  }
  return process.env.META_GRAPH_TOKEN || null;
}

async function metaFetch(url, init = {}) {
  try {
    const r = await fetch(url, init);
    const txt = await r.text();
    let json = null;
    try { json = txt ? JSON.parse(txt) : {}; } catch { json = { _raw: txt }; }
    if (!r.ok || json?.error) {
      return {
        ok: false,
        status: r.status,
        error: json?.error?.message || json?._raw || `http_${r.status}`,
        raw: json,
      };
    }
    return { ok: true, status: r.status, data: json };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

/**
 * Cria campanha (PAUSED).
 */
export async function metaCreateCampaign(token, accountId, { name, objective, special_ad_categories = [] }) {
  if (!token) return { ok: false, error: 'sem_token' };
  if (!accountId) return { ok: false, error: 'account_id_ausente' };
  const url = `${META_API}/act_${accountId}/campaigns`;
  const body = new URLSearchParams({
    name: name || 'Campanha',
    objective: objective || 'OUTCOME_TRAFFIC',
    status: 'PAUSED',
    special_ad_categories: JSON.stringify(special_ad_categories),
    access_token: token,
  });
  return metaFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

/**
 * Cria adset (PAUSED).
 */
export async function metaCreateAdset(token, accountId, {
  name, campaign_id, daily_budget, targeting, optimization_goal,
  billing_event = 'IMPRESSIONS', bid_strategy = 'LOWEST_COST_WITHOUT_CAP',
  start_time, end_time,
}) {
  if (!token) return { ok: false, error: 'sem_token' };
  const url = `${META_API}/act_${accountId}/adsets`;
  const body = new URLSearchParams({
    name: name || 'AdSet',
    campaign_id: String(campaign_id || ''),
    daily_budget: String(daily_budget || 0),
    targeting: JSON.stringify(targeting || {}),
    optimization_goal: optimization_goal || 'LINK_CLICKS',
    billing_event,
    bid_strategy,
    status: 'PAUSED',
    access_token: token,
  });
  if (start_time) body.set('start_time', start_time);
  if (end_time) body.set('end_time', end_time);
  return metaFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

/**
 * Cria ad (PAUSED).
 * `creative` deve ser { creative_id } ou { name, object_story_spec, ... }
 */
export async function metaCreateAd(token, accountId, { name, adset_id, creative }) {
  if (!token) return { ok: false, error: 'sem_token' };
  const url = `${META_API}/act_${accountId}/ads`;
  const body = new URLSearchParams({
    name: name || 'Ad',
    adset_id: String(adset_id || ''),
    creative: JSON.stringify(creative || {}),
    status: 'PAUSED',
    access_token: token,
  });
  return metaFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

/**
 * Faz upload de imagem para a ad account → retorna {hash}.
 */
export async function metaUploadImage(token, accountId, fileBuffer, filename = 'image.jpg') {
  if (!token) return { ok: false, error: 'sem_token' };
  if (!fileBuffer || !fileBuffer.length) return { ok: false, error: 'arquivo_vazio' };
  const url = `${META_API}/act_${accountId}/adimages?access_token=${encodeURIComponent(token)}`;
  const boundary = '----fenice-wizard-' + Date.now().toString(36);
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="filename"; filename="${filename.replace(/"/g, '')}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`,
    'utf-8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
  const body = Buffer.concat([head, fileBuffer, tail]);
  const res = await metaFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  if (!res.ok) return res;
  // Resposta vem como { images: { <filename>: { hash, url } } }
  const images = res.data && res.data.images;
  const first = images && Object.values(images)[0];
  if (!first || !first.hash) {
    return { ok: false, error: 'meta_sem_hash', raw: res.data };
  }
  return { ok: true, hash: first.hash, url: first.url || null };
}

/**
 * Faz upload de vídeo para a ad account → retorna {video_id}.
 */
export async function metaUploadVideo(token, accountId, fileBuffer, filename = 'video.mp4') {
  if (!token) return { ok: false, error: 'sem_token' };
  if (!fileBuffer || !fileBuffer.length) return { ok: false, error: 'arquivo_vazio' };
  // ⚠️ Pra vídeos grandes Meta exige upload em chunks (start/transfer/finish).
  // Por simplicidade: tentamos upload direto (multipart). Funciona até ~100MB
  // segundo Meta. Pra arquivos maiores, marcamos como issue.
  const url = `${META_API}/act_${accountId}/advideos?access_token=${encodeURIComponent(token)}`;
  const boundary = '----fenice-wizard-' + Date.now().toString(36);
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="source"; filename="${filename.replace(/"/g, '')}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`,
    'utf-8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
  const body = Buffer.concat([head, fileBuffer, tail]);
  const res = await metaFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  if (!res.ok) return res;
  const id = res.data?.id;
  if (!id) return { ok: false, error: 'meta_sem_video_id', raw: res.data };
  return { ok: true, video_id: id, thumb_url: null };
}

/**
 * Delivery estimate. Retorna estimate_dau {lower_bound, upper_bound}.
 * Tem fallback mock se Meta off.
 */
export async function metaDeliveryEstimate(token, accountId, { targeting, optimization_goal }) {
  const fallback = {
    ok: true,
    estimate_ready: false,
    estimate_dau: { lower_bound: 1200, upper_bound: 4500 },
    note: 'mock_fallback',
  };
  if (!token || !accountId) return fallback;
  const targetingSpec = encodeURIComponent(JSON.stringify(targeting || {}));
  const url = `${META_API}/act_${accountId}/delivery_estimate` +
    `?targeting_spec=${targetingSpec}` +
    `&optimization_goal=${encodeURIComponent(optimization_goal || 'LINK_CLICKS')}` +
    `&access_token=${encodeURIComponent(token)}`;
  const res = await metaFetch(url);
  if (!res.ok) {
    console.warn(TAG, 'delivery_estimate falhou:', res.error);
    return fallback;
  }
  const first = res.data?.data?.[0];
  if (!first) return fallback;
  return {
    ok: true,
    estimate_ready: !!first.estimate_ready,
    estimate_dau: {
      lower_bound: Number(first.estimate_dau_lower_bound ?? first.estimate_dau ?? 0),
      upper_bound: Number(first.estimate_dau_upper_bound ?? first.estimate_dau ?? 0),
    },
  };
}

// =============================================================================
// Multipart parser (simples — pra POST /api/creative/upload)
// ⚠️ NÃO usar pra arquivos > 50MB. Mantém TUDO em memória. Sem streaming.
// =============================================================================

/**
 * Parser manual de multipart/form-data.
 * @param {Buffer} buffer       corpo completo da request
 * @param {string} contentType  header Content-Type
 * @returns {{fields:object, files:object[]}}
 *    files: [{ name, filename, contentType, data:Buffer }]
 */
export function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  if (!m) throw new Error('boundary_ausente');
  const boundary = m[1] || m[2];
  const delim = Buffer.from('--' + boundary);
  const fields = {};
  const files = [];

  // split por delimitador
  const parts = [];
  let from = 0;
  while (true) {
    const idx = buffer.indexOf(delim, from);
    if (idx === -1) break;
    if (parts.length > 0) {
      parts[parts.length - 1].end = idx - 2; // remove \r\n antes do delim
    }
    // próximo bloco começa depois do delim + \r\n
    const after = idx + delim.length;
    // tolera --boundary-- final
    if (buffer[after] === 0x2d && buffer[after + 1] === 0x2d) break;
    parts.push({ start: after + 2 /* skip \r\n */, end: buffer.length });
    from = after + 2;
  }

  for (const p of parts) {
    if (p.start >= p.end) continue;
    const block = buffer.slice(p.start, p.end);
    // separa headers do body por \r\n\r\n
    const sep = block.indexOf(Buffer.from('\r\n\r\n'));
    if (sep === -1) continue;
    const headerStr = block.slice(0, sep).toString('utf-8');
    const data = block.slice(sep + 4);

    const dispMatch = /Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(headerStr);
    if (!dispMatch) continue;
    const name = dispMatch[1];
    const filename = dispMatch[2];
    const ctMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerStr);
    const ct = ctMatch ? ctMatch[1].trim() : 'application/octet-stream';

    if (filename != null) {
      files.push({ name, filename, contentType: ct, data });
    } else {
      fields[name] = data.toString('utf-8');
    }
  }

  return { fields, files };
}

// =============================================================================
// Helpers internos
// =============================================================================

function findClientBySlug(mapping, slug) {
  if (!mapping || !Array.isArray(mapping.clients)) return null;
  return mapping.clients.find((c) => c.slug === slug) || null;
}

async function safeAudit(ctx, entry) {
  try {
    if (ctx && typeof ctx.logAuditEntry === 'function') {
      await ctx.logAuditEntry(entry);
    }
  } catch (e) {
    console.warn(TAG, 'audit falhou:', e.message);
  }
}

async function safeNotify(ctx, entry) {
  try {
    if (ctx && typeof ctx.notifyBotIfCritical === 'function') {
      await ctx.notifyBotIfCritical(entry);
    }
  } catch {}
}

// =============================================================================
// HANDLERS — chamados pelo server.mjs
// Cada um recebe ctx = { supabase, logAuditEntry, notifyBotIfCritical, mapping, readToken }
// =============================================================================

// -----------------------------------------------------------------------------
// 1) POST /api/campaign/draft   — INSERT/UPDATE rascunho
// -----------------------------------------------------------------------------
export async function handleDraftSave(req, res, body, ctx) {
  const { supabase } = ctx || {};
  if (!supabase) return err(res, 500, 'supabase_indisponivel');
  if (!body || typeof body !== 'object') return err(res, 400, 'body_invalido');

  const {
    id, slug, vertical, objetivo, nome,
    payload, budget_diario_cents, data_inicio, data_fim,
    actor_email, actor_auth_id,
  } = body;

  if (!actor_auth_id) return err(res, 400, 'actor_auth_id_ausente');
  if (!slug) return err(res, 400, 'slug_ausente');

  const auth = await validateActor(supabase, actor_auth_id);
  if (!auth.ok) return err(res, 403, auth.error);
  if (!actorCanAccessSlug(auth.user, slug)) return err(res, 403, 'sem_acesso_ao_slug');

  if (vertical && !VERTICAIS_VALIDAS.includes(vertical)) {
    return err(res, 400, 'vertical_invalido');
  }

  const row = {
    slug,
    vertical: vertical || null,
    objetivo: objetivo || null,
    nome: nome || null,
    payload: payload || {},
    budget_diario_cents: budget_diario_cents != null ? Number(budget_diario_cents) : null,
    data_inicio: data_inicio || null,
    data_fim: data_fim || null,
  };

  try {
    let dbRes;
    if (id) {
      // UPDATE — só se status=draft e dono confere
      const { data: existing, error: getErr } = await supabase
        .from('campanhas_draft')
        .select('id, status, criado_por_auth_id, slug')
        .eq('id', id)
        .maybeSingle();
      if (getErr) return err(res, 500, `db: ${getErr.message}`);
      if (!existing) return err(res, 404, 'draft_nao_encontrado');
      if (existing.status !== 'draft') {
        return err(res, 400, `status_nao_editavel: ${existing.status}`);
      }
      if (auth.user.role !== 'admin_fenice' && existing.criado_por_auth_id !== actor_auth_id) {
        return err(res, 403, 'sem_acesso_ao_draft');
      }
      dbRes = await supabase
        .from('campanhas_draft')
        .update(row)
        .eq('id', id)
        .select('id, status, atualizado_em')
        .single();
    } else {
      // INSERT
      dbRes = await supabase
        .from('campanhas_draft')
        .insert({
          ...row,
          status: 'draft',
          criado_por_auth_id: actor_auth_id,
          criado_por_email: actor_email || auth.user.email || null,
        })
        .select('id, status, atualizado_em')
        .single();
    }
    if (dbRes.error) return err(res, 500, `db: ${dbRes.error.message}`);

    await safeAudit(ctx, {
      slug,
      action: id ? 'draft_update' : 'draft_create',
      entity_type: 'campaign_draft',
      entity_id: dbRes.data.id,
      actor: actor_email || auth.user.email,
      ok: true,
    });

    return ok(res, { draft: dbRes.data });
  } catch (e) {
    return err(res, 500, e.message);
  }
}

// -----------------------------------------------------------------------------
// 2) GET /api/campaign/drafts?slug=X&status=Y
// -----------------------------------------------------------------------------
export async function handleDraftsList(req, res, query, ctx) {
  const { supabase } = ctx || {};
  if (!supabase) return err(res, 500, 'supabase_indisponivel');

  const slug = query?.get?.('slug') || null;
  const status = query?.get?.('status') || null;
  const actorAuthId = query?.get?.('actor_auth_id') || null;

  if (!actorAuthId) return err(res, 400, 'actor_auth_id_ausente');
  const auth = await validateActor(supabase, actorAuthId);
  if (!auth.ok) return err(res, 403, auth.error);

  // Cliente: força slug ao próprio
  let effectiveSlug = slug;
  if (auth.user.role !== 'admin_fenice') {
    effectiveSlug = auth.user.cliente_slug;
    if (slug && slug !== auth.user.cliente_slug) {
      return err(res, 403, 'sem_acesso_ao_slug');
    }
  }

  try {
    let q = supabase
      .from('campanhas_draft')
      .select('id, slug, vertical, objetivo, nome, status, budget_diario_cents, data_inicio, data_fim, criado_por_email, criado_em, atualizado_em, publicada_em')
      .order('atualizado_em', { ascending: false })
      .limit(200);
    if (effectiveSlug) q = q.eq('slug', effectiveSlug);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) return err(res, 500, `db: ${error.message}`);
    return ok(res, { drafts: data || [] });
  } catch (e) {
    return err(res, 500, e.message);
  }
}

// -----------------------------------------------------------------------------
// 3) GET /api/campaign/draft/:id  — detalhe completo
// -----------------------------------------------------------------------------
export async function handleDraftGet(req, res, id, ctx) {
  const { supabase } = ctx || {};
  if (!supabase) return err(res, 500, 'supabase_indisponivel');
  if (!id) return err(res, 400, 'id_ausente');

  const url = new URL(req.url, 'http://x');
  const actorAuthId = url.searchParams.get('actor_auth_id');
  if (!actorAuthId) return err(res, 400, 'actor_auth_id_ausente');
  const auth = await validateActor(supabase, actorAuthId);
  if (!auth.ok) return err(res, 403, auth.error);

  try {
    const { data, error } = await supabase
      .from('campanhas_draft')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) return err(res, 500, `db: ${error.message}`);
    if (!data) return err(res, 404, 'draft_nao_encontrado');
    if (!actorCanAccessSlug(auth.user, data.slug)) {
      return err(res, 403, 'sem_acesso_ao_draft');
    }
    return ok(res, { draft: data });
  } catch (e) {
    return err(res, 500, e.message);
  }
}

// -----------------------------------------------------------------------------
// 4) POST /api/campaign/submit  — valida e marca aguardando_aprovacao
// -----------------------------------------------------------------------------
export async function handleSubmit(req, res, body, ctx) {
  const { supabase } = ctx || {};
  if (!supabase) return err(res, 500, 'supabase_indisponivel');
  const { id, actor_email, actor_auth_id } = body || {};
  if (!id) return err(res, 400, 'id_ausente');
  if (!actor_auth_id) return err(res, 400, 'actor_auth_id_ausente');

  const auth = await validateActor(supabase, actor_auth_id);
  if (!auth.ok) return err(res, 403, auth.error);

  try {
    const { data: draft, error: getErr } = await supabase
      .from('campanhas_draft')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (getErr) return err(res, 500, `db: ${getErr.message}`);
    if (!draft) return err(res, 404, 'draft_nao_encontrado');
    if (!actorCanAccessSlug(auth.user, draft.slug)) {
      return err(res, 403, 'sem_acesso_ao_draft');
    }
    if (draft.status !== 'draft') {
      return err(res, 400, `status_nao_submetivel: ${draft.status}`);
    }

    const rowCheck = validateDraftRow(draft);
    const payloadCheck = validateDraftPayload(draft.payload);
    const allErrors = [...rowCheck.errors, ...payloadCheck.errors];
    if (allErrors.length) {
      return err(res, 400, 'validacao_falhou', { errors: allErrors });
    }

    const { data: upd, error: upErr } = await supabase
      .from('campanhas_draft')
      .update({ status: 'aguardando_aprovacao' })
      .eq('id', id)
      .select('id, status, atualizado_em')
      .single();
    if (upErr) return err(res, 500, `db: ${upErr.message}`);

    const auditEntry = {
      slug: draft.slug,
      action: 'campaign_submit',
      entity_type: 'campaign_draft',
      entity_id: id,
      entity_name: draft.nome,
      actor: actor_email || auth.user.email,
      ok: true,
    };
    await safeAudit(ctx, auditEntry);
    await safeNotify(ctx, auditEntry);

    return ok(res, { draft: upd });
  } catch (e) {
    return err(res, 500, e.message);
  }
}

// -----------------------------------------------------------------------------
// 5) POST /api/campaign/approve  — admin aprova e publica no Meta
// -----------------------------------------------------------------------------
export async function handleApprove(req, res, body, ctx) {
  const { supabase, mapping } = ctx || {};
  if (!supabase) return err(res, 500, 'supabase_indisponivel');
  const { id, aprovado_por, actor_auth_id } = body || {};
  if (!id) return err(res, 400, 'id_ausente');
  if (!actor_auth_id) return err(res, 400, 'actor_auth_id_ausente');

  const auth = await validateActor(supabase, actor_auth_id, 'admin_fenice');
  if (!auth.ok) return err(res, 403, auth.error);
  const aprovador = aprovado_por || auth.user.email || 'admin';

  try {
    const { data: draft, error: getErr } = await supabase
      .from('campanhas_draft')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (getErr) return err(res, 500, `db: ${getErr.message}`);
    if (!draft) return err(res, 404, 'draft_nao_encontrado');
    if (draft.status !== 'aguardando_aprovacao') {
      return err(res, 400, `status_nao_aprovavel: ${draft.status}`);
    }

    const client = findClientBySlug(mapping, draft.slug);
    if (!client || !client.ad_account_id) {
      return err(res, 404, 'cliente_sem_ad_account');
    }

    const token = await getMetaToken(ctx);
    if (!token) return err(res, 502, 'sem_token_meta');

    const accountId = client.ad_account_id;
    const meta_adset_ids = [];
    const meta_ad_ids = [];
    let meta_campaign_id = null;
    let metaError = null;

    // 1) Cria campanha
    const camp = await metaCreateCampaign(token, accountId, {
      name: draft.nome,
      objective: draft.objetivo,
    });
    if (!camp.ok) {
      metaError = { step: 'campaign', error: camp.error, raw: camp.raw || null };
    } else {
      meta_campaign_id = camp.data?.id || null;

      // 2) Cria adset
      const p = draft.payload || {};
      const startTime = draft.data_inicio ? `${draft.data_inicio}T00:00:00-0300` : undefined;
      const endTime = draft.data_fim ? `${draft.data_fim}T23:59:59-0300` : undefined;
      const adset = await metaCreateAdset(token, accountId, {
        name: `${draft.nome} — adset`,
        campaign_id: meta_campaign_id,
        daily_budget: draft.budget_diario_cents,
        targeting: p.targeting || {},
        optimization_goal: p.optimization_goal,
        billing_event: p.billing_event || 'IMPRESSIONS',
        start_time: startTime,
        end_time: endTime,
      });
      if (!adset.ok) {
        metaError = { step: 'adset', error: adset.error, raw: adset.raw || null };
      } else {
        const adsetId = adset.data?.id;
        if (adsetId) meta_adset_ids.push(adsetId);

        // 3) Cria ad
        const creativeSpec = p.creative_spec
          ? p.creative_spec
          : (p.criativo && p.criativo.creative_id
              ? { creative_id: p.criativo.creative_id }
              : { name: `${draft.nome} — creative`, object_story_spec: p.object_story_spec || {} });
        const ad = await metaCreateAd(token, accountId, {
          name: `${draft.nome} — ad`,
          adset_id: adsetId,
          creative: creativeSpec,
        });
        if (!ad.ok) {
          metaError = { step: 'ad', error: ad.error, raw: ad.raw || null };
        } else if (ad.data?.id) {
          meta_ad_ids.push(ad.data.id);
        }
      }
    }

    // Decide status final
    const finalStatus = metaError ? 'aprovada' : 'publicada';
    const updates = {
      status: finalStatus,
      aprovada_por_email: aprovador,
      aprovada_em: new Date().toISOString(),
      meta_campaign_id,
      meta_adset_ids,
      meta_ad_ids,
    };
    if (finalStatus === 'publicada') {
      updates.publicada_em = new Date().toISOString();
    }
    if (metaError) {
      updates.payload = { ...(draft.payload || {}), meta_error: metaError };
    }

    const { data: upd, error: upErr } = await supabase
      .from('campanhas_draft')
      .update(updates)
      .eq('id', id)
      .select('id, status, meta_campaign_id, meta_adset_ids, meta_ad_ids, publicada_em, aprovada_em')
      .single();
    if (upErr) return err(res, 500, `db: ${upErr.message}`);

    const auditEntry = {
      slug: draft.slug,
      action: metaError ? 'campaign_approve_meta_error' : 'campaign_publish',
      entity_type: 'campaign',
      entity_id: meta_campaign_id || id,
      entity_name: draft.nome,
      actor: aprovador,
      ok: !metaError,
      error: metaError ? `${metaError.step}: ${metaError.error}` : null,
    };
    await safeAudit(ctx, auditEntry);
    await safeNotify(ctx, auditEntry);

    if (metaError) {
      return jsonResp(res, 502, {
        ok: false,
        error: 'meta_publish_falhou',
        meta_error: metaError,
        draft: upd,
      });
    }
    return ok(res, { draft: upd });
  } catch (e) {
    return err(res, 500, e.message);
  }
}

// -----------------------------------------------------------------------------
// 6) POST /api/campaign/reject  — admin rejeita
// -----------------------------------------------------------------------------
export async function handleReject(req, res, body, ctx) {
  const { supabase } = ctx || {};
  if (!supabase) return err(res, 500, 'supabase_indisponivel');
  const { id, rejeitado_por, motivo, actor_auth_id } = body || {};
  if (!id) return err(res, 400, 'id_ausente');
  if (!motivo || String(motivo).trim().length < 3) return err(res, 400, 'motivo_curto');
  if (!actor_auth_id) return err(res, 400, 'actor_auth_id_ausente');

  const auth = await validateActor(supabase, actor_auth_id, 'admin_fenice');
  if (!auth.ok) return err(res, 403, auth.error);
  const rejeitador = rejeitado_por || auth.user.email || 'admin';

  try {
    const { data: draft, error: getErr } = await supabase
      .from('campanhas_draft')
      .select('id, slug, status, nome')
      .eq('id', id)
      .maybeSingle();
    if (getErr) return err(res, 500, `db: ${getErr.message}`);
    if (!draft) return err(res, 404, 'draft_nao_encontrado');
    if (draft.status !== 'aguardando_aprovacao') {
      return err(res, 400, `status_nao_rejeitavel: ${draft.status}`);
    }

    const { data: upd, error: upErr } = await supabase
      .from('campanhas_draft')
      .update({
        status: 'rejeitada',
        rejeitado_por_email: rejeitador,
        rejeitada_em: new Date().toISOString(),
        rejeicao_motivo: motivo,
      })
      .eq('id', id)
      .select('id, status, rejeitada_em, rejeicao_motivo')
      .single();
    if (upErr) return err(res, 500, `db: ${upErr.message}`);

    const auditEntry = {
      slug: draft.slug,
      action: 'campaign_reject',
      entity_type: 'campaign_draft',
      entity_id: id,
      entity_name: draft.nome,
      actor: rejeitador,
      ok: true,
      error: motivo,
    };
    await safeAudit(ctx, auditEntry);
    await safeNotify(ctx, auditEntry);

    return ok(res, { draft: upd });
  } catch (e) {
    return err(res, 500, e.message);
  }
}

// -----------------------------------------------------------------------------
// 7) POST /api/creative/upload  — multipart upload de imagem ou vídeo
// -----------------------------------------------------------------------------
export async function handleCreativeUpload(req, res, rawBody, contentType, ctx) {
  const { supabase, mapping } = ctx || {};
  if (!supabase) return err(res, 500, 'supabase_indisponivel');
  if (!rawBody || !Buffer.isBuffer(rawBody)) return err(res, 400, 'body_ausente');
  if (!contentType || !contentType.toLowerCase().startsWith('multipart/form-data')) {
    return err(res, 400, 'content_type_invalido');
  }

  let parsed;
  try {
    parsed = parseMultipart(rawBody, contentType);
  } catch (e) {
    return err(res, 400, `multipart: ${e.message}`);
  }

  const slug = parsed.fields.slug;
  const tipo = parsed.fields.tipo;
  const actor_email = parsed.fields.actor_email || null;
  const actor_auth_id = parsed.fields.actor_auth_id || null;
  const file = parsed.files.find((f) => f.name === 'file') || parsed.files[0];

  if (!slug) return err(res, 400, 'slug_ausente');
  if (!tipo || !['image', 'video'].includes(tipo)) return err(res, 400, 'tipo_invalido');
  if (!file) return err(res, 400, 'arquivo_ausente');
  if (!actor_auth_id) return err(res, 400, 'actor_auth_id_ausente');

  const auth = await validateActor(supabase, actor_auth_id);
  if (!auth.ok) return err(res, 403, auth.error);
  if (!actorCanAccessSlug(auth.user, slug)) return err(res, 403, 'sem_acesso_ao_slug');

  const client = findClientBySlug(mapping, slug);
  if (!client || !client.ad_account_id) return err(res, 404, 'cliente_sem_ad_account');

  const token = await getMetaToken(ctx);
  if (!token) return err(res, 502, 'sem_token_meta');

  try {
    let metaRes;
    if (tipo === 'image') {
      metaRes = await metaUploadImage(token, client.ad_account_id, file.data, file.filename);
    } else {
      metaRes = await metaUploadVideo(token, client.ad_account_id, file.data, file.filename);
    }
    if (!metaRes.ok) {
      await safeAudit(ctx, {
        slug, action: 'creative_upload', entity_type: 'creative',
        actor: actor_email || auth.user.email,
        ok: false, error: metaRes.error,
      });
      return err(res, 502, `meta: ${metaRes.error}`);
    }
    await safeAudit(ctx, {
      slug, action: 'creative_upload', entity_type: 'creative',
      entity_id: metaRes.hash || metaRes.video_id,
      actor: actor_email || auth.user.email,
      ok: true,
    });
    return ok(res, {
      tipo,
      hash: metaRes.hash || null,
      video_id: metaRes.video_id || null,
      thumb_url: metaRes.thumb_url || null,
      url: metaRes.url || null,
    });
  } catch (e) {
    return err(res, 500, e.message);
  }
}

// -----------------------------------------------------------------------------
// 8) GET /api/audience/estimate  — delivery estimate
// -----------------------------------------------------------------------------
export async function handleAudienceEstimate(req, res, query, ctx) {
  const { mapping } = ctx || {};
  const slug = query?.get?.('slug') || null;
  const targetingRaw = query?.get?.('targeting') || null;
  const optimization_goal = query?.get?.('optimization_goal') || 'LINK_CLICKS';

  if (!slug) return err(res, 400, 'slug_ausente');
  if (!targetingRaw) return err(res, 400, 'targeting_ausente');

  let targeting;
  try {
    targeting = JSON.parse(targetingRaw);
  } catch {
    return err(res, 400, 'targeting_json_invalido');
  }

  const client = findClientBySlug(mapping, slug);
  if (!client || !client.ad_account_id) return err(res, 404, 'cliente_sem_ad_account');

  const token = await getMetaToken(ctx);
  // metaDeliveryEstimate já tem fallback se Meta off
  const est = await metaDeliveryEstimate(token, client.ad_account_id, {
    targeting, optimization_goal,
  });
  return ok(res, est);
}
