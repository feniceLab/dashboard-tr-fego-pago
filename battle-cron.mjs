// ──────────────────────────────────────────────────────────────────────────────
// battle-cron.mjs — Avaliação periódica de Campanhas Battle
//
// `runBattleCron(ctx)` é o entrypoint. Iterar battles ativos, somar gasto via
// Meta insights, se >= budget aplica a estratégia (manual/auto_kill/auto_scale).
//
// `ctx` = { supabase, mapping, logAuditEntry, notifyBotIfCritical,
//           META_GRAPH_TOKEN, META_API }
//
// Pra agendar (exemplo no server.mjs):
//   import { runBattleCron } from './battle-cron.mjs';
//   setInterval(() => runBattleCron(battleCtx).catch(console.error),
//               15 * 60 * 1000);
// ──────────────────────────────────────────────────────────────────────────────

'use strict';

import {
  calcRanking,
  metaGetCampaignInsights,
  metaPauseCampaign,
  metaUrl,
  safeAudit,
  safeNotify,
} from './battle-helpers.mjs';

// ──────────────────────────────────────────────────────────────────────────────
// runBattleCron — entrypoint
// ──────────────────────────────────────────────────────────────────────────────
async function runBattleCron(ctx) {
  if (!ctx?.supabase) {
    console.log('[battle-cron] supabase indisponível, abortando');
    return { ok: false, error: 'supabase_indisponivel' };
  }

  const t0 = Date.now();
  console.log('[battle-cron] início');

  let battles;
  try {
    const { data, error } = await ctx.supabase
      .from('campanhas_battle')
      .select('*')
      .eq('status', 'ativo');
    if (error) {
      console.log('[battle-cron] supabase erro', error.message);
      return { ok: false, error: 'supabase_error', detail: error.message };
    }
    battles = data || [];
  } catch (e) {
    console.log('[battle-cron] exception ao buscar battles', e.message);
    return { ok: false, error: 'exception', detail: e.message };
  }

  console.log(`[battle-cron] ${battles.length} battles ativos`);

  const resultados = [];
  for (const battle of battles) {
    try {
      const evalRes = await evaluateBattle(battle, ctx);
      console.log(
        `[battle-cron] battle=${battle.id} slug=${battle.slug} gasto=${evalRes.gastoTotal} budget=${battle.budget_total_cents} finaliza=${evalRes.shouldFinalize}`,
      );
      resultados.push({ battle_id: battle.id, ...evalRes, applied: null });

      if (evalRes.shouldFinalize) {
        const apply = await applyStrategy(battle, evalRes.ranking, ctx);
        resultados[resultados.length - 1].applied = apply;
      }
    } catch (e) {
      console.log(`[battle-cron] battle=${battle.id} exception`, e.message);
      resultados.push({ battle_id: battle.id, error: e.message });
    }
  }

  console.log(`[battle-cron] fim em ${Date.now() - t0}ms`);
  return { ok: true, processados: battles.length, resultados };
}

// ──────────────────────────────────────────────────────────────────────────────
// evaluateBattle
// retorna { shouldFinalize, gastoTotal, ranking, membros }
// ──────────────────────────────────────────────────────────────────────────────
async function evaluateBattle(battle, ctx) {
  const { data: membros, error } = await ctx.supabase
    .from('campanhas_battle_membros')
    .select('*')
    .eq('battle_id', battle.id);

  if (error) {
    throw new Error(`supabase_membros: ${error.message}`);
  }
  if (!membros || membros.length === 0) {
    return { shouldFinalize: false, gastoTotal: 0, ranking: [], membros: [] };
  }

  const sinceDate = battle.iniciado_em;
  const comInsights = await Promise.all(
    membros.map(async (m) => {
      const ins = await metaGetCampaignInsights(m.meta_campaign_id, sinceDate, ctx);
      return { ...m, insights: ins.ok ? ins : { error: ins.error } };
    }),
  );

  const gastoTotal = comInsights.reduce((acc, m) => acc + (m.insights?.spend_cents || 0), 0);
  const ranking = calcRanking(comInsights, battle.criterio);
  const budget = Number(battle.budget_total_cents || 0);
  const shouldFinalize = budget > 0 && gastoTotal >= budget;

  return { shouldFinalize, gastoTotal, ranking, membros: comInsights };
}

// ──────────────────────────────────────────────────────────────────────────────
// applyStrategy
// ──────────────────────────────────────────────────────────────────────────────
async function applyStrategy(battle, ranking, ctx) {
  const vencedora = ranking[0]; // primeiro do ranking
  const venc_cid = vencedora ? vencedora.meta_campaign_id : null;
  const estrategia = battle.estrategia;

  if (estrategia === 'manual') {
    // Não finaliza, não pausa. Apenas avisa pro cliente decidir.
    await safeNotify(ctx, {
      slug: battle.slug,
      severity: 'warning',
      title: `Battle aguarda decisão: ${battle.nome}`,
      detail: `Budget esgotado. Vencedora sugerida: ${venc_cid}`,
      action: 'battle_aguarda_decisao',
      battle,
      ranking,
    });
    await safeAudit(ctx, {
      slug: battle.slug,
      action: 'battle_aguarda_decisao',
      entity_type: 'battle',
      entity_id: battle.id,
      actor: 'cron',
      ok: true,
      ranking_top: vencedora?.meta_campaign_id,
    });
    return { strategy: 'manual', finalized: false, suggested: venc_cid };
  }

  if (estrategia === 'auto_kill') {
    return await finalizeWithAutoKill(battle, ranking, venc_cid, ctx);
  }

  if (estrategia === 'auto_scale') {
    return await finalizeWithAutoScale(battle, ranking, venc_cid, ctx);
  }

  console.log(`[battle-cron] estrategia desconhecida=${estrategia} battle=${battle.id}`);
  return { strategy: estrategia, finalized: false, error: 'estrategia_desconhecida' };
}

// ──────────────────────────────────────────────────────────────────────────────
// auto_kill: pausa não-vencedoras, finaliza
// ──────────────────────────────────────────────────────────────────────────────
async function finalizeWithAutoKill(battle, ranking, venc_cid, ctx) {
  const nowIso = new Date().toISOString();
  const pausadas = [];
  for (const m of ranking) {
    if (String(m.meta_campaign_id) === String(venc_cid)) continue;
    const r = await metaPauseCampaign(m.meta_campaign_id, ctx);
    pausadas.push({ meta_campaign_id: m.meta_campaign_id, ok: r.ok, error: r.error });
  }

  await updateBattleFinalized(battle, ranking, venc_cid, 'auto_kill', ctx);

  await safeNotify(ctx, {
    slug: battle.slug,
    severity: 'info',
    title: `Battle finalizado (auto_kill): ${battle.nome}`,
    detail: `Vencedora: ${venc_cid} | pausadas: ${pausadas.length}`,
    action: 'battle_finalizado',
    ranking,
  });

  return { strategy: 'auto_kill', finalized: true, vencedora_campaign_id: venc_cid, pausadas };
}

// ──────────────────────────────────────────────────────────────────────────────
// auto_scale: pausa não-vencedoras + aumenta adset_budget da vencedora em +20%
// ──────────────────────────────────────────────────────────────────────────────
async function finalizeWithAutoScale(battle, ranking, venc_cid, ctx) {
  const pausadas = [];
  for (const m of ranking) {
    if (String(m.meta_campaign_id) === String(venc_cid)) continue;
    const r = await metaPauseCampaign(m.meta_campaign_id, ctx);
    pausadas.push({ meta_campaign_id: m.meta_campaign_id, ok: r.ok, error: r.error });
  }

  // busca adsets da vencedora e escala +20%
  const adsets = await metaListCampaignAdsets(venc_cid, ctx);
  const escaladas = [];
  if (adsets.ok) {
    for (const a of adsets.adsets) {
      const r = await metaScaleAdsetBudget(a.id, 1.2, a, ctx);
      escaladas.push({ adset_id: a.id, ok: r.ok, error: r.error, novo_daily_budget: r.novo_daily_budget });
    }
  }

  await updateBattleFinalized(battle, ranking, venc_cid, 'auto_scale', ctx, {
    escaladas,
    pausadas,
  });

  await safeNotify(ctx, {
    slug: battle.slug,
    severity: 'info',
    title: `Battle finalizado (auto_scale): ${battle.nome}`,
    detail: `Vencedora: ${venc_cid} | adsets escalados: ${escaladas.filter((x) => x.ok).length}`,
    action: 'battle_finalizado',
    ranking,
    escaladas,
  });

  return {
    strategy: 'auto_scale',
    finalized: true,
    vencedora_campaign_id: venc_cid,
    pausadas,
    escaladas,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Persistência: marca battle finalizado e atualiza membros
// ──────────────────────────────────────────────────────────────────────────────
async function updateBattleFinalized(battle, ranking, venc_cid, decisao, ctx, extra = {}) {
  const nowIso = new Date().toISOString();
  const { error: upErr } = await ctx.supabase
    .from('campanhas_battle')
    .update({
      status: 'finalizado',
      vencedora_campaign_id: String(venc_cid),
      finalizado_em: nowIso,
      atualizado_em: nowIso,
      resultado_payload: { ranking, decisao, actor: 'cron', ...extra },
    })
    .eq('id', battle.id);

  if (upErr) {
    console.log(`[battle-cron] update battle falhou battle=${battle.id}`, upErr.message);
    return;
  }

  for (const r of ranking) {
    const isVenc = String(r.meta_campaign_id) === String(venc_cid);
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
    if (muErr) console.log(`[battle-cron] update membro falhou ${r.id}`, muErr.message);
  }

  await safeAudit(ctx, {
    slug: battle.slug,
    action: 'battle_finalizado',
    entity_type: 'battle',
    entity_id: battle.id,
    actor: 'cron',
    ok: true,
    decisao,
    vencedora_campaign_id: venc_cid,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Meta: listar adsets de uma campanha
// ──────────────────────────────────────────────────────────────────────────────
async function metaListCampaignAdsets(campaignId, ctx) {
  if (!campaignId) return { ok: false, error: 'campaign_id_vazio' };
  if (!ctx?.META_GRAPH_TOKEN) return { ok: false, error: 'sem_token' };
  const url = metaUrl(ctx.META_API, `/${campaignId}/adsets`, {
    fields: 'id,name,daily_budget,lifetime_budget,status',
    access_token: ctx.META_GRAPH_TOKEN,
  });
  try {
    const r = await fetch(url, { method: 'GET' });
    const j = await r.json();
    if (!r.ok || j?.error) {
      return { ok: false, error: 'meta_error', detail: j?.error?.message || r.statusText };
    }
    return { ok: true, adsets: j?.data || [] };
  } catch (e) {
    return { ok: false, error: 'meta_fetch_failed', detail: e.message };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// metaScaleAdsetBudget — multiplica daily_budget por `factor`
// `adsetInfo` pode trazer o daily_budget atual; senão busca.
// ──────────────────────────────────────────────────────────────────────────────
async function metaScaleAdsetBudget(adsetId, factor, adsetInfo, ctx) {
  if (!adsetId) return { ok: false, error: 'adset_id_vazio' };
  if (!ctx?.META_GRAPH_TOKEN) return { ok: false, error: 'sem_token' };
  const fac = Number(factor);
  if (!Number.isFinite(fac) || fac <= 0) return { ok: false, error: 'factor_invalido' };

  let oldBudget = adsetInfo?.daily_budget;
  if (oldBudget == null) {
    const url = metaUrl(ctx.META_API, `/${adsetId}`, {
      fields: 'daily_budget,lifetime_budget',
      access_token: ctx.META_GRAPH_TOKEN,
    });
    try {
      const r = await fetch(url, { method: 'GET' });
      const j = await r.json();
      if (!r.ok || j?.error) {
        return { ok: false, error: 'meta_error', detail: j?.error?.message || r.statusText };
      }
      oldBudget = j.daily_budget;
    } catch (e) {
      return { ok: false, error: 'meta_fetch_failed', detail: e.message };
    }
  }

  // Meta retorna budget em unidades menores (cents) como string. Mantemos cents.
  const oldNum = Number(oldBudget);
  if (!Number.isFinite(oldNum) || oldNum <= 0) {
    return { ok: false, error: 'sem_daily_budget', detail: 'adset usa lifetime_budget ou orçamento de campanha' };
  }
  const novo = Math.round(oldNum * fac);

  const postUrl = metaUrl(ctx.META_API, `/${adsetId}`, {
    daily_budget: String(novo),
    access_token: ctx.META_GRAPH_TOKEN,
  });
  try {
    const r = await fetch(postUrl, { method: 'POST' });
    const j = await r.json();
    if (!r.ok || j?.error) {
      return { ok: false, error: 'meta_error', detail: j?.error?.message || r.statusText };
    }
    return { ok: true, daily_budget_anterior: oldNum, novo_daily_budget: novo };
  } catch (e) {
    return { ok: false, error: 'meta_fetch_failed', detail: e.message };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────────────────────────
export {
  runBattleCron,
  evaluateBattle,
  applyStrategy,
  metaScaleAdsetBudget,
  metaListCampaignAdsets,
};
