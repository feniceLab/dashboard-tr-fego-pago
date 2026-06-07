// ──────────────────────────────────────────────────────────────────────────────
// battle-helpers.mjs — Campanhas Battle (A/B/C de campanhas no mesmo budget)
//
// Handlers HTTP pra `server.mjs` registrar em /api/battle/*. Cada handler recebe
// `(req, res, body|query|battleId, ctx)` onde `ctx` é fornecido pelo server.mjs:
//
//   ctx = { supabase, mapping, logAuditEntry, notifyBotIfCritical,
//           META_GRAPH_TOKEN, META_API }
//
// Sem deps novas. ESM puro, Node 20+.
// ──────────────────────────────────────────────────────────────────────────────

'use strict';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers de response
// ──────────────────────────────────────────────────────────────────────────────
function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function sendOk(res, payload, status = 200) {
  sendJson(res, status, { ok: true, ...payload });
}

function sendErr(res, status, error, extra = {}) {
  console.log('[battle] erro', status, error, extra);
  sendJson(res, status, { ok: false, error, ...extra });
}

// ──────────────────────────────────────────────────────────────────────────────
// Validação de ator via Supabase
//
// Espera tabela `usuarios` com colunas:
//   - auth_id (uuid), email, cliente_slug (nullable se admin global), role
//
// `requiredRole` opcional. Se passado, força ator a ter essa role.
// Se `slug` passado, ator precisa ter cliente_slug=igual OU role='admin_fenice'.
// ──────────────────────────────────────────────────────────────────────────────
async function validateActor(supabase, authId, slug, requiredRole) {
  if (!supabase) return { ok: false, status: 500, error: 'supabase_indisponivel' };
  if (!authId) return { ok: false, status: 403, error: 'sem_actor_auth_id' };

  try {
    const { data, error } = await supabase
      .from('usuarios')
      .select('auth_id,email,cliente_slug,role')
      .eq('auth_id', authId)
      .limit(1);

    if (error) {
      console.log('[battle] validateActor supabase error', error.message);
      return { ok: false, status: 502, error: 'supabase_error', detail: error.message };
    }
    if (!data || data.length === 0) {
      return { ok: false, status: 403, error: 'ator_nao_encontrado' };
    }

    const user = data[0];
    const isAdmin = user.role === 'admin_fenice';

    if (requiredRole && user.role !== requiredRole && !isAdmin) {
      return { ok: false, status: 403, error: 'sem_permissao', detail: `requer ${requiredRole}` };
    }

    if (slug && !isAdmin && user.cliente_slug !== slug) {
      return { ok: false, status: 403, error: 'sem_acesso_ao_slug', detail: slug };
    }

    return { ok: true, user };
  } catch (e) {
    console.log('[battle] validateActor exception', e.message);
    return { ok: false, status: 500, error: 'validate_actor_failed', detail: e.message };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Meta Graph API — wrappers
// ──────────────────────────────────────────────────────────────────────────────
function metaUrl(META_API, path, params = {}) {
  const u = new URL(`${META_API}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  return u.toString();
}

async function metaGetCampaignInsights(campaignId, sinceDate, ctx) {
  if (!campaignId) return { ok: false, error: 'campaign_id_vazio' };
  if (!ctx?.META_GRAPH_TOKEN) return { ok: false, error: 'sem_token' };

  const params = {
    fields: 'spend,actions,action_values,ctr,impressions,clicks,date_start,date_stop',
    access_token: ctx.META_GRAPH_TOKEN,
  };
  if (sinceDate) {
    const since = new Date(sinceDate);
    if (!isNaN(since.getTime())) {
      const until = new Date();
      params.time_range = JSON.stringify({
        since: since.toISOString().slice(0, 10),
        until: until.toISOString().slice(0, 10),
      });
    } else {
      params.date_preset = 'maximum';
    }
  } else {
    params.date_preset = 'maximum';
  }

  const url = metaUrl(ctx.META_API, `/${campaignId}/insights`, params);
  try {
    const r = await fetch(url, { method: 'GET' });
    const j = await r.json();
    if (!r.ok || j?.error) {
      return { ok: false, error: 'meta_error', detail: j?.error?.message || r.statusText };
    }
    const row = (j?.data && j.data[0]) || {};
    const spend = Number(row.spend || 0); // currency unit
    const ctr = Number(row.ctr || 0);
    const impressions = Number(row.impressions || 0);
    const clicks = Number(row.clicks || 0);
    let purchases = 0;
    let revenue = 0;
    if (Array.isArray(row.actions)) {
      const a = row.actions.find((x) => x.action_type === 'purchase' || x.action_type === 'omni_purchase');
      if (a) purchases = Number(a.value || 0);
    }
    if (Array.isArray(row.action_values)) {
      const a = row.action_values.find((x) => x.action_type === 'purchase' || x.action_type === 'omni_purchase');
      if (a) revenue = Number(a.value || 0);
    }
    return {
      ok: true,
      spend,
      spend_cents: Math.round(spend * 100),
      revenue,
      revenue_cents: Math.round(revenue * 100),
      purchases,
      ctr,
      impressions,
      clicks,
      roas: spend > 0 ? revenue / spend : 0,
      cpa: purchases > 0 ? spend / purchases : null,
      raw: row,
    };
  } catch (e) {
    return { ok: false, error: 'meta_fetch_failed', detail: e.message };
  }
}

async function metaSetCampaignStatus(campaignId, status, ctx) {
  if (!campaignId) return { ok: false, error: 'campaign_id_vazio' };
  if (!ctx?.META_GRAPH_TOKEN) return { ok: false, error: 'sem_token' };
  const url = metaUrl(ctx.META_API, `/${campaignId}`, {
    status,
    access_token: ctx.META_GRAPH_TOKEN,
  });
  try {
    const r = await fetch(url, { method: 'POST' });
    const j = await r.json();
    if (!r.ok || j?.error) {
      return { ok: false, error: 'meta_error', detail: j?.error?.message || r.statusText };
    }
    return { ok: true, response: j };
  } catch (e) {
    return { ok: false, error: 'meta_fetch_failed', detail: e.message };
  }
}

async function metaPauseCampaign(campaignId, ctx) {
  return metaSetCampaignStatus(campaignId, 'PAUSED', ctx);
}

async function metaActivateCampaign(campaignId, ctx) {
  return metaSetCampaignStatus(campaignId, 'ACTIVE', ctx);
}

async function metaGetCampaignAccount(campaignId, ctx) {
  if (!campaignId) return { ok: false, error: 'campaign_id_vazio' };
  const url = metaUrl(ctx.META_API, `/${campaignId}`, {
    fields: 'account_id,name,status',
    access_token: ctx.META_GRAPH_TOKEN,
  });
  try {
    const r = await fetch(url, { method: 'GET' });
    const j = await r.json();
    if (!r.ok || j?.error) {
      return { ok: false, error: 'meta_error', detail: j?.error?.message || r.statusText };
    }
    return { ok: true, account_id: j.account_id, name: j.name, status: j.status };
  } catch (e) {
    return { ok: false, error: 'meta_fetch_failed', detail: e.message };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Ranking
//
// `membros` = [{ meta_campaign_id, nome_campanha, insights: {spend, revenue,
//                purchases, roas, cpa, ctr, spend_cents, revenue_cents} }]
// `criterio` ∈ 'roas' | 'cpa' | 'volume_compras' | 'ctr'
//
// Retorna array ordenado com `metrica_ranking` e `posicao_atual`.
// ──────────────────────────────────────────────────────────────────────────────
function calcRanking(membros, criterio) {
  const arr = membros.map((m) => {
    const ins = m.insights || {};
    let metrica = 0;
    switch (criterio) {
      case 'roas':
        metrica = ins.roas || 0;
        break;
      case 'cpa':
        metrica = ins.cpa == null ? Number.POSITIVE_INFINITY : ins.cpa;
        break;
      case 'volume_compras':
        metrica = ins.purchases || 0;
        break;
      case 'ctr':
        metrica = ins.ctr || 0;
        break;
      default:
        metrica = ins.roas || 0;
    }
    return { ...m, metrica_ranking: metrica };
  });

  // cpa: menor é melhor; demais: maior é melhor
  const asc = criterio === 'cpa';
  arr.sort((a, b) => (asc ? a.metrica_ranking - b.metrica_ranking : b.metrica_ranking - a.metrica_ranking));
  arr.forEach((m, i) => {
    m.posicao_atual = i + 1;
  });
  return arr;
}

// ──────────────────────────────────────────────────────────────────────────────
// Body helpers
// ──────────────────────────────────────────────────────────────────────────────
function requireFields(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length) return `campos_obrigatorios_ausentes: ${missing.join(',')}`;
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/battle/create
// ──────────────────────────────────────────────────────────────────────────────
async function handleBattleCreate(req, res, body, ctx) {
  try {
    const miss = requireFields(body || {}, [
      'slug',
      'nome',
      'budget_total_cents',
      'criterio',
      'estrategia',
      'campaign_ids',
      'actor_email',
      'actor_auth_id',
    ]);
    if (miss) return sendErr(res, 400, miss);

    const { slug, nome, budget_total_cents, criterio, estrategia, campaign_ids, actor_email, actor_auth_id } = body;

    const budget = Number(budget_total_cents);
    if (!Number.isFinite(budget) || budget <= 0) {
      return sendErr(res, 400, 'budget_total_cents_invalido');
    }
    if (!['roas', 'cpa', 'volume_compras', 'ctr'].includes(criterio)) {
      return sendErr(res, 400, 'criterio_invalido');
    }
    if (!['manual', 'auto_kill', 'auto_scale'].includes(estrategia)) {
      return sendErr(res, 400, 'estrategia_invalida');
    }
    if (!Array.isArray(campaign_ids) || campaign_ids.length < 2 || campaign_ids.length > 5) {
      return sendErr(res, 400, 'campaign_ids_deve_ter_2_a_5');
    }

    // ator
    const v = await validateActor(ctx.supabase, actor_auth_id, slug);
    if (!v.ok) return sendErr(res, v.status, v.error, { detail: v.detail });

    // (best-effort) valida ownership das campanhas no ad_account do slug
    const clientMapping = (ctx.mapping?.clients || []).find((c) => c.slug === slug);
    if (clientMapping?.ad_account_id) {
      const accExpected = String(clientMapping.ad_account_id).replace(/^act_/, '');
      for (const cid of campaign_ids) {
        const meta = await metaGetCampaignAccount(cid, ctx);
        if (meta.ok && meta.account_id && String(meta.account_id) !== accExpected) {
          return sendErr(res, 400, 'campanha_fora_da_conta', {
            detail: `campanha ${cid} pertence a ${meta.account_id}, esperado ${accExpected}`,
          });
        }
      }
    }

    const nowIso = new Date().toISOString();

    // INSERT battle
    const { data: battles, error: battleErr } = await ctx.supabase
      .from('campanhas_battle')
      .insert({
        slug,
        nome,
        criado_por_email: actor_email,
        budget_total_cents: budget,
        criterio,
        estrategia,
        status: 'ativo',
        iniciado_em: nowIso,
      })
      .select()
      .limit(1);

    if (battleErr || !battles || !battles[0]) {
      return sendErr(res, 502, 'insert_battle_failed', { detail: battleErr?.message });
    }
    const battle = battles[0];

    // INSERT membros
    const membrosPayload = campaign_ids.map((cid, i) => ({
      battle_id: battle.id,
      meta_campaign_id: String(cid),
      nome_campanha: body.campanhas_meta?.[i]?.nome || body.nomes_campanhas?.[i] || null,
    }));
    const { data: membros, error: membrosErr } = await ctx.supabase
      .from('campanhas_battle_membros')
      .insert(membrosPayload)
      .select();

    if (membrosErr) {
      // tenta rollback simples
      await ctx.supabase.from('campanhas_battle').delete().eq('id', battle.id);
      return sendErr(res, 502, 'insert_membros_failed', { detail: membrosErr.message });
    }

    await safeAudit(ctx, {
      slug,
      action: 'battle_created',
      entity_type: 'battle',
      entity_id: battle.id,
      actor: actor_email,
      ok: true,
    });

    return sendOk(res, { battle, membros }, 201);
  } catch (e) {
    console.log('[battle] handleBattleCreate exception', e);
    return sendErr(res, 500, 'exception', { detail: e.message });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/battle/list
//   ?slug=X (opcional; sem slug => admin only)
//   ?status=Y (opcional)
// ──────────────────────────────────────────────────────────────────────────────
async function handleBattleList(req, res, query, ctx) {
  try {
    const slug = query?.slug || null;
    const status = query?.status || null;
    const actor_auth_id = query?.actor_auth_id;

    if (!actor_auth_id) return sendErr(res, 403, 'sem_actor_auth_id');

    if (!slug) {
      const v = await validateActor(ctx.supabase, actor_auth_id, null, 'admin_fenice');
      if (!v.ok) return sendErr(res, v.status, v.error, { detail: v.detail });
    } else {
      const v = await validateActor(ctx.supabase, actor_auth_id, slug);
      if (!v.ok) return sendErr(res, v.status, v.error, { detail: v.detail });
    }

    let q = ctx.supabase.from('campanhas_battle').select('*').order('criado_em', { ascending: false });
    if (slug) q = q.eq('slug', slug);
    if (status) q = q.eq('status', status);

    const { data: battles, error } = await q;
    if (error) return sendErr(res, 502, 'supabase_error', { detail: error.message });

    const ids = (battles || []).map((b) => b.id);
    let counts = {};
    if (ids.length > 0) {
      const { data: membros, error: mErr } = await ctx.supabase
        .from('campanhas_battle_membros')
        .select('battle_id')
        .in('battle_id', ids);
      if (mErr) return sendErr(res, 502, 'supabase_error_membros', { detail: mErr.message });
      counts = (membros || []).reduce((acc, m) => {
        acc[m.battle_id] = (acc[m.battle_id] || 0) + 1;
        return acc;
      }, {});
    }

    const out = (battles || []).map((b) => ({
      id: b.id,
      slug: b.slug,
      nome: b.nome,
      status: b.status,
      budget_total_cents: b.budget_total_cents,
      criterio: b.criterio,
      estrategia: b.estrategia,
      n_campanhas: counts[b.id] || 0,
      criado_em: b.criado_em,
      iniciado_em: b.iniciado_em,
      finalizado_em: b.finalizado_em,
      vencedora_campaign_id: b.vencedora_campaign_id,
    }));

    return sendOk(res, { battles: out });
  } catch (e) {
    console.log('[battle] handleBattleList exception', e);
    return sendErr(res, 500, 'exception', { detail: e.message });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/battle/:id
// Ranking ao vivo via Meta insights
// ──────────────────────────────────────────────────────────────────────────────
async function handleBattleGet(req, res, battleId, ctx, query) {
  try {
    if (!battleId) return sendErr(res, 400, 'battle_id_obrigatorio');
    const actor_auth_id = query?.actor_auth_id;
    if (!actor_auth_id) return sendErr(res, 403, 'sem_actor_auth_id');

    const { data: battles, error } = await ctx.supabase
      .from('campanhas_battle')
      .select('*')
      .eq('id', battleId)
      .limit(1);
    if (error) return sendErr(res, 502, 'supabase_error', { detail: error.message });
    if (!battles || !battles[0]) return sendErr(res, 404, 'battle_nao_encontrado');
    const battle = battles[0];

    const v = await validateActor(ctx.supabase, actor_auth_id, battle.slug);
    if (!v.ok) return sendErr(res, v.status, v.error, { detail: v.detail });

    const { data: membros, error: mErr } = await ctx.supabase
      .from('campanhas_battle_membros')
      .select('*')
      .eq('battle_id', battleId);
    if (mErr) return sendErr(res, 502, 'supabase_error_membros', { detail: mErr.message });

    // Busca insights pra cada
    const sinceDate = battle.iniciado_em;
    const membrosComInsights = await Promise.all(
      (membros || []).map(async (m) => {
        const ins = await metaGetCampaignInsights(m.meta_campaign_id, sinceDate, ctx);
        return {
          ...m,
          insights: ins.ok ? ins : { error: ins.error, detail: ins.detail },
          insights_ok: !!ins.ok,
        };
      }),
    );

    const ranking = calcRanking(membrosComInsights, battle.criterio);
    const gasto_total_cents = ranking.reduce((acc, m) => acc + (m.insights?.spend_cents || 0), 0);
    const budget = Number(battle.budget_total_cents || 0);
    const budget_restante_cents = Math.max(0, budget - gasto_total_cents);
    const pct_gasto = budget > 0 ? gasto_total_cents / budget : 0;

    const proxAvaliacao = battle.iniciado_em
      ? new Date(new Date(battle.iniciado_em).getTime() + 6 * 60 * 60 * 1000).toISOString()
      : null;

    return sendOk(res, {
      battle,
      membros: ranking,
      progresso: {
        gasto_total_cents,
        budget_restante_cents,
        pct_gasto,
      },
      prox_avaliacao_em: proxAvaliacao,
    });
  } catch (e) {
    console.log('[battle] handleBattleGet exception', e);
    return sendErr(res, 500, 'exception', { detail: e.message });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/battle/:id/cancel
// ──────────────────────────────────────────────────────────────────────────────
async function handleBattleCancel(req, res, battleId, body, ctx) {
  try {
    if (!battleId) return sendErr(res, 400, 'battle_id_obrigatorio');
    const { actor_email, actor_auth_id } = body || {};
    if (!actor_auth_id) return sendErr(res, 403, 'sem_actor_auth_id');

    const { data: battles, error } = await ctx.supabase
      .from('campanhas_battle')
      .select('*')
      .eq('id', battleId)
      .limit(1);
    if (error) return sendErr(res, 502, 'supabase_error', { detail: error.message });
    if (!battles || !battles[0]) return sendErr(res, 404, 'battle_nao_encontrado');
    const battle = battles[0];

    const v = await validateActor(ctx.supabase, actor_auth_id, battle.slug);
    if (!v.ok) return sendErr(res, v.status, v.error, { detail: v.detail });

    if (battle.status === 'cancelado' || battle.status === 'finalizado') {
      return sendErr(res, 400, 'battle_ja_encerrado', { status: battle.status });
    }

    const { error: upErr } = await ctx.supabase
      .from('campanhas_battle')
      .update({ status: 'cancelado', atualizado_em: new Date().toISOString() })
      .eq('id', battleId);
    if (upErr) return sendErr(res, 502, 'update_failed', { detail: upErr.message });

    await safeAudit(ctx, {
      slug: battle.slug,
      action: 'battle_cancelado',
      entity_type: 'battle',
      entity_id: battle.id,
      actor: actor_email,
      ok: true,
    });

    await safeNotify(ctx, {
      slug: battle.slug,
      severity: 'info',
      title: 'Battle cancelado',
      detail: battle.nome,
      action: 'battle_cancelado',
    });

    return sendOk(res, { battle_id: battleId, status: 'cancelado' });
  } catch (e) {
    console.log('[battle] handleBattleCancel exception', e);
    return sendErr(res, 500, 'exception', { detail: e.message });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/battle/:id/decidir
// Body: { vencedora_campaign_id, manter_pausadas:true, actor_email, actor_auth_id }
// ──────────────────────────────────────────────────────────────────────────────
async function handleBattleDecidir(req, res, battleId, body, ctx) {
  try {
    if (!battleId) return sendErr(res, 400, 'battle_id_obrigatorio');
    const miss = requireFields(body || {}, ['vencedora_campaign_id', 'actor_email', 'actor_auth_id']);
    if (miss) return sendErr(res, 400, miss);

    const { vencedora_campaign_id, actor_email, actor_auth_id } = body;

    const { data: battles, error } = await ctx.supabase
      .from('campanhas_battle')
      .select('*')
      .eq('id', battleId)
      .limit(1);
    if (error) return sendErr(res, 502, 'supabase_error', { detail: error.message });
    if (!battles || !battles[0]) return sendErr(res, 404, 'battle_nao_encontrado');
    const battle = battles[0];

    const v = await validateActor(ctx.supabase, actor_auth_id, battle.slug);
    if (!v.ok) return sendErr(res, v.status, v.error, { detail: v.detail });

    if (battle.status !== 'ativo') {
      return sendErr(res, 400, 'battle_nao_ativo', { status: battle.status });
    }

    const { data: membros, error: mErr } = await ctx.supabase
      .from('campanhas_battle_membros')
      .select('*')
      .eq('battle_id', battleId);
    if (mErr) return sendErr(res, 502, 'supabase_error_membros', { detail: mErr.message });

    const venc = (membros || []).find((m) => String(m.meta_campaign_id) === String(vencedora_campaign_id));
    if (!venc) return sendErr(res, 400, 'vencedora_nao_eh_membro');

    // calcula ranking ao vivo pra registrar métricas finais
    const sinceDate = battle.iniciado_em;
    const comInsights = await Promise.all(
      membros.map(async (m) => {
        const ins = await metaGetCampaignInsights(m.meta_campaign_id, sinceDate, ctx);
        return { ...m, insights: ins.ok ? ins : {} };
      }),
    );
    const ranking = calcRanking(comInsights, battle.criterio);

    // pausa não-vencedoras
    const nowIso = new Date().toISOString();
    const pausadas = [];
    for (const m of membros) {
      if (String(m.meta_campaign_id) === String(vencedora_campaign_id)) continue;
      const r = await metaPauseCampaign(m.meta_campaign_id, ctx);
      pausadas.push({ meta_campaign_id: m.meta_campaign_id, ok: r.ok, error: r.error });
    }

    // update battle
    const { error: upErr } = await ctx.supabase
      .from('campanhas_battle')
      .update({
        status: 'finalizado',
        vencedora_campaign_id: String(vencedora_campaign_id),
        finalizado_em: nowIso,
        atualizado_em: nowIso,
        resultado_payload: { ranking, decisao: 'manual', actor: actor_email },
      })
      .eq('id', battleId);
    if (upErr) return sendErr(res, 502, 'update_failed', { detail: upErr.message });

    // update membros
    for (const r of ranking) {
      const isVenc = String(r.meta_campaign_id) === String(vencedora_campaign_id);
      const upd = {
        posicao_final: isVenc ? 1 : r.posicao_atual,
        metrica_final: r.metrica_ranking == null || !isFinite(r.metrica_ranking) ? null : r.metrica_ranking,
        gasto_final_cents: r.insights?.spend_cents || 0,
      };
      if (!isVenc) upd.pausada_em = nowIso;
      const { error: muErr } = await ctx.supabase
        .from('campanhas_battle_membros')
        .update(upd)
        .eq('id', r.id);
      if (muErr) console.log('[battle] update membro falhou', r.id, muErr.message);
    }

    await safeAudit(ctx, {
      slug: battle.slug,
      action: 'battle_finalizado',
      entity_type: 'battle',
      entity_id: battle.id,
      actor: actor_email,
      ok: true,
      ranking,
    });

    await safeNotify(ctx, {
      slug: battle.slug,
      severity: 'info',
      title: `Battle finalizado: ${battle.nome}`,
      detail: `Vencedora: ${vencedora_campaign_id} | decisão: manual`,
      action: 'battle_finalizado',
      ranking,
    });

    return sendOk(res, { battle_id: battleId, status: 'finalizado', vencedora_campaign_id, ranking, pausadas });
  } catch (e) {
    console.log('[battle] handleBattleDecidir exception', e);
    return sendErr(res, 500, 'exception', { detail: e.message });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/battle/:id/revert
// Reativa quem foi pausada há < 24h, cancela o battle.
// ──────────────────────────────────────────────────────────────────────────────
async function handleBattleRevert(req, res, battleId, body, ctx) {
  try {
    if (!battleId) return sendErr(res, 400, 'battle_id_obrigatorio');
    const miss = requireFields(body || {}, ['actor_email', 'actor_auth_id']);
    if (miss) return sendErr(res, 400, miss);
    const { actor_email, actor_auth_id } = body;

    const { data: battles, error } = await ctx.supabase
      .from('campanhas_battle')
      .select('*')
      .eq('id', battleId)
      .limit(1);
    if (error) return sendErr(res, 502, 'supabase_error', { detail: error.message });
    if (!battles || !battles[0]) return sendErr(res, 404, 'battle_nao_encontrado');
    const battle = battles[0];

    const v = await validateActor(ctx.supabase, actor_auth_id, battle.slug);
    if (!v.ok) return sendErr(res, v.status, v.error, { detail: v.detail });

    const { data: membros, error: mErr } = await ctx.supabase
      .from('campanhas_battle_membros')
      .select('*')
      .eq('battle_id', battleId);
    if (mErr) return sendErr(res, 502, 'supabase_error_membros', { detail: mErr.message });

    const now = Date.now();
    const reativadas = [];
    const ignoradas = [];
    for (const m of membros || []) {
      if (!m.pausada_em) continue;
      const diffMs = now - new Date(m.pausada_em).getTime();
      if (diffMs >= 24 * 60 * 60 * 1000) {
        ignoradas.push({ meta_campaign_id: m.meta_campaign_id, reason: 'mais_de_24h' });
        continue;
      }
      const r = await metaActivateCampaign(m.meta_campaign_id, ctx);
      reativadas.push({ meta_campaign_id: m.meta_campaign_id, ok: r.ok, error: r.error });
      if (r.ok) {
        await ctx.supabase
          .from('campanhas_battle_membros')
          .update({ pausada_em: null })
          .eq('id', m.id);
      }
    }

    const nowIso = new Date().toISOString();
    const { error: upErr } = await ctx.supabase
      .from('campanhas_battle')
      .update({ status: 'cancelado', atualizado_em: nowIso })
      .eq('id', battleId);
    if (upErr) return sendErr(res, 502, 'update_failed', { detail: upErr.message });

    await safeAudit(ctx, {
      slug: battle.slug,
      action: 'battle_revertido',
      entity_type: 'battle',
      entity_id: battle.id,
      actor: actor_email,
      ok: true,
      reativadas,
      ignoradas,
    });

    await safeNotify(ctx, {
      slug: battle.slug,
      severity: 'warning',
      title: `Battle revertido: ${battle.nome}`,
      detail: `Reativadas: ${reativadas.length} | ignoradas (>=24h): ${ignoradas.length}`,
      action: 'battle_revertido',
    });

    return sendOk(res, { battle_id: battleId, status: 'cancelado', reativadas, ignoradas });
  } catch (e) {
    console.log('[battle] handleBattleRevert exception', e);
    return sendErr(res, 500, 'exception', { detail: e.message });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Audit + notify helpers (best effort)
// ──────────────────────────────────────────────────────────────────────────────
async function safeAudit(ctx, entry) {
  try {
    if (ctx?.logAuditEntry) await ctx.logAuditEntry(entry);
  } catch (e) {
    console.log('[battle] audit falhou', e.message);
  }
}

async function safeNotify(ctx, payload) {
  try {
    if (ctx?.notifyBotIfCritical) await ctx.notifyBotIfCritical(payload);
  } catch (e) {
    console.log('[battle] notify falhou', e.message);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────────────────────────
export {
  // handlers HTTP
  handleBattleCreate,
  handleBattleList,
  handleBattleGet,
  handleBattleCancel,
  handleBattleDecidir,
  handleBattleRevert,
  // internos (úteis pro cron)
  validateActor,
  calcRanking,
  metaGetCampaignInsights,
  metaPauseCampaign,
  metaActivateCampaign,
  metaSetCampaignStatus,
  metaGetCampaignAccount,
  safeAudit,
  safeNotify,
  metaUrl,
};
