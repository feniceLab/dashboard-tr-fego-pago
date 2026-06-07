// ──────────────────────────────────────────────────────────────────────────────
// criativos-hd.mjs — Helper isolado para enriquecer criativos com HD
//
// Frente 1: enrichAdsWithHd(ads, accountId)
//   Adiciona `image_url_hd` e `thumb_url_hd` em cada ad (mantém campos atuais).
//   Cache in-memory Map, TTL 24h por ad_id.
//
// Frente 2: handleAdDetail(req, res, query) / getAdDetail(adId, accountId, preset)
//   Endpoint GET /api/ad-detail?slug=X&ad_id=Y&preset=last_30d
//   Retorna criativo + métricas + tendência + demografia + placements.
//   Cache 15min por `${adId}:${preset}`.
//
// Padrão: ESM .mjs, sem deps novas, logs [ads-hd] e [ad-detail].
// Token e mapping são lidos em runtime via process.env e fs (sem importar do server).
// ──────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const META_API = process.env.META_API || 'https://graph.facebook.com/v23.0';

const HD_CACHE = new Map();      // ad_id → { image_url_hd, thumb_url_hd, fetched_at }
const DETAIL_CACHE = new Map();  // `${ad_id}:${preset}` → { data, fetched_at }

const HD_TTL_MS = 24 * 60 * 60 * 1000;     // 24h
const DETAIL_TTL_MS = 15 * 60 * 1000;      // 15min
const HD_BATCH_SIZE = 25;                  // limite seguro pra /?ids=...
const HD_MAX_ADS = 60;                     // enrich só os top-N por ad ; resto fica como veio

// ──────────────────────────────────────────────────────────────────────────────
// Helpers internos
// ──────────────────────────────────────────────────────────────────────────────

async function readToken() {
  if (process.env.META_GRAPH_TOKEN) return process.env.META_GRAPH_TOKEN.trim();
  // Fallback: TOKEN_FILE (mesmo padrão usado no server.mjs)
  if (process.env.TOKEN_FILE) {
    try { return (await fs.readFile(process.env.TOKEN_FILE, 'utf-8')).trim(); } catch {}
  }
  return null;
}

async function readMappingClientBySlug(slug) {
  try {
    const raw = await fs.readFile(path.join(__dirname, 'data', 'clients-mapping.json'), 'utf-8');
    const map = JSON.parse(raw);
    return (map.clients || []).find((c) => c.slug === slug && c.ad_account_id) || null;
  } catch {
    return null;
  }
}

function actVal(arr, type) {
  const f = (arr || []).find((x) => x.action_type === type);
  return f ? Number(f.value) : null;
}

function cents(v) {
  return v != null && !Number.isNaN(Number(v)) ? Math.round(Number(v) * 100) : null;
}

// Escolhe melhor imagem HD a partir do creative object da Meta.
// Prioridade: image_crops 1080 → image_crops 600 → image_url → null
function pickHdImage(creative) {
  if (!creative || typeof creative !== 'object') return null;
  const crops = creative.image_crops || {};

  // image_crops vem como objeto: { "100x100": {source:..., images:[{source,height,width}]}, ... }
  // Tentamos várias chaves de tamanho, da maior pra menor.
  const sizeKeys = ['1080x1080', '1080x1920', '1200x628', '600x600', '600x315', '400x400'];
  for (const key of sizeKeys) {
    const crop = crops[key];
    if (crop) {
      if (typeof crop.source === 'string') return crop.source;
      if (Array.isArray(crop.images) && crop.images[0]?.source) return crop.images[0].source;
    }
  }

  // Fallback: image_url (640px) — melhor que thumbnail_url (~64px)
  if (typeof creative.image_url === 'string') return creative.image_url;
  return null;
}

// Detecta se o criativo é vídeo e retorna { video_id, page_id, instagram_actor_id }
function pickVideoIds(creative) {
  const out = { video_id: null, page_id: null, instagram_actor_id: null };
  if (!creative) return out;
  const oss = creative.object_story_spec || {};
  if (oss.video_data?.video_id) out.video_id = oss.video_data.video_id;
  if (oss.page_id) out.page_id = oss.page_id;
  if (creative.instagram_actor_id) out.instagram_actor_id = creative.instagram_actor_id;
  if (creative.video_id && !out.video_id) out.video_id = creative.video_id;
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Frente 1: Enrichment HD pro /api/ads existente
// ──────────────────────────────────────────────────────────────────────────────

// Busca em batch criativo HD pra um lote de ad_ids via ?ids=... (limit batch)
async function fetchHdBatch(adIds, token) {
  if (!adIds.length) return {};
  const ids = adIds.join(',');
  const fields = [
    'creative{image_url,image_hash,image_crops,object_story_spec,instagram_actor_id,video_id}',
  ].join(',');
  const url = `${META_API}/?ids=${encodeURIComponent(ids)}&fields=${fields}&access_token=${token}`;
  try {
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) {
      console.warn(`[ads-hd] batch error: ${j.error.message}`);
      return {};
    }
    const out = {};
    for (const adId of Object.keys(j)) {
      if (adId === 'error') continue;
      out[adId] = j[adId];
    }
    return out;
  } catch (e) {
    console.warn(`[ads-hd] batch fetch failed: ${e.message}`);
    return {};
  }
}

// Busca a source (mp4) + permalink de um vídeo.
// A Meta frequentemente NÃO retorna `source` (depende de permissão/idade do vídeo);
// nesse caso retornamos source=null e o caller cai no fallback de thumbnail.
async function metaFetchVideoSource(videoId, token) {
  if (!videoId) return null;
  const url = `${META_API}/${videoId}?fields=source,permalink_url,picture&access_token=${token}`;
  try {
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) {
      console.warn(`[ad-detail] video source ${videoId} error: ${j.error.message}`);
      return null;
    }
    return {
      source: typeof j.source === 'string' ? j.source : null,
      permalink_url: typeof j.permalink_url === 'string' ? j.permalink_url : null,
      picture: typeof j.picture === 'string' ? j.picture : null,
    };
  } catch (e) {
    console.warn(`[ad-detail] video source ${videoId} fetch failed: ${e.message}`);
    return null;
  }
}

// Busca thumbnails HD de um vídeo (uri preferido)
async function metaFetchVideoThumbs(videoId, token) {
  if (!videoId) return null;
  const url = `${META_API}/${videoId}?fields=picture,thumbnails{uri,is_preferred,width,height}&access_token=${token}`;
  try {
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) return null;
    const thumbs = (j.thumbnails?.data || []).slice();
    // Prefere is_preferred=true; depois maior largura
    thumbs.sort((a, b) => {
      if (a.is_preferred && !b.is_preferred) return -1;
      if (!a.is_preferred && b.is_preferred) return 1;
      return (Number(b.width) || 0) - (Number(a.width) || 0);
    });
    const best = thumbs[0]?.uri || j.picture || null;
    return best;
  } catch {
    return null;
  }
}

// Resolve (image_url_hd, thumb_url_hd) a partir de uma entrada de batch (ad_id → {creative,...})
// Retorna {image_url_hd, thumb_url_hd, video_id?}.
function resolveHdFromBatchEntry(entry) {
  if (!entry) return { image_url_hd: null, thumb_url_hd: null, video_id: null };
  const creative = entry.creative || {};
  const hdImg = pickHdImage(creative);
  const { video_id } = pickVideoIds(creative);
  const thumb = entry.thumbnail_url || creative.thumbnail_url || null;
  return {
    image_url_hd: hdImg,
    thumb_url_hd: thumb,
    video_id,
  };
}

/**
 * enrichAdsWithHd
 * Recebe array de ads (do fetchAds atual) e devolve novo array com
 * `image_url_hd` e `thumb_url_hd` adicionados (sem remover nada).
 * Mantém ordem original.
 *
 * @param {Array} ads
 * @param {string} accountId — não usado diretamente nas chamadas (ad_id já é endpoint), mas reservado.
 * @returns {Promise<Array>}
 */
export async function enrichAdsWithHd(ads, accountId) {
  if (!Array.isArray(ads) || ads.length === 0) return ads || [];
  const token = await readToken();
  if (!token) {
    console.warn('[ads-hd] sem token — pulando enrichment');
    return ads;
  }

  const now = Date.now();
  const adIdsToFetch = [];
  const cached = {};

  // 1. Separa o que já está em cache válido vs o que precisa buscar
  const targets = ads.slice(0, HD_MAX_ADS);
  for (const ad of targets) {
    if (!ad.ad_id) continue;
    const c = HD_CACHE.get(ad.ad_id);
    if (c && (now - c.fetched_at) < HD_TTL_MS) {
      cached[ad.ad_id] = c;
    } else {
      adIdsToFetch.push(ad.ad_id);
    }
  }

  // 2. Fetch em batches do que falta
  const fetched = {};
  for (let i = 0; i < adIdsToFetch.length; i += HD_BATCH_SIZE) {
    const batch = adIdsToFetch.slice(i, i + HD_BATCH_SIZE);
    const result = await fetchHdBatch(batch, token);
    for (const adId of Object.keys(result)) {
      fetched[adId] = resolveHdFromBatchEntry(result[adId]);
    }
  }

  // 3. Pra ads com video_id mas sem image_url_hd, busca thumb do vídeo
  //    Limitado pra não estourar rate limit.
  const videoFetches = [];
  for (const adId of Object.keys(fetched)) {
    const f = fetched[adId];
    if (f.video_id && (!f.image_url_hd || f.image_url_hd === f.thumb_url_hd)) {
      videoFetches.push(
        metaFetchVideoThumbs(f.video_id, token).then((uri) => {
          if (uri) {
            fetched[adId].image_url_hd = uri;
            if (!fetched[adId].thumb_url_hd) fetched[adId].thumb_url_hd = uri;
          }
        })
      );
    }
  }
  if (videoFetches.length) await Promise.allSettled(videoFetches);

  // 4. Atualiza cache
  for (const adId of Object.keys(fetched)) {
    HD_CACHE.set(adId, {
      image_url_hd: fetched[adId].image_url_hd,
      thumb_url_hd: fetched[adId].thumb_url_hd,
      fetched_at: now,
    });
  }

  console.log(`[ads-hd] enriched=${Object.keys(fetched).length} cached=${Object.keys(cached).length} total=${ads.length}`);

  // 5. Devolve ads com campos extras
  return ads.map((ad) => {
    if (!ad || !ad.ad_id) return ad;
    const hit = cached[ad.ad_id] || fetched[ad.ad_id];
    if (!hit) return ad;
    return {
      ...ad,
      image_url_hd: hit.image_url_hd || null,
      thumb_url_hd: hit.thumb_url_hd || ad.thumbnail_url || null,
    };
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Frente 2: /api/ad-detail
// ──────────────────────────────────────────────────────────────────────────────

async function metaFetchAdCreative(adId, token) {
  const fields = [
    'name',
    'status',
    'effective_status',
    'campaign{name,id}',
    'adset{name,id}',
    'creative{image_url,image_hash,image_crops,video_id,object_story_spec,instagram_actor_id,object_url,title,body,call_to_action_type,effective_object_story_id,instagram_permalink_url}',
  ].join(',');
  const url = `${META_API}/${adId}?fields=${fields}&access_token=${token}`;
  try {
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) {
      console.warn(`[ad-detail] creative ${adId} error: ${j.error.message}`);
      return null;
    }
    return j;
  } catch (e) {
    console.warn(`[ad-detail] creative ${adId} fetch failed: ${e.message}`);
    return null;
  }
}

async function metaFetchAdInsights(adId, token, { preset, fields, extra = '' }) {
  const rangeParam = `date_preset=${encodeURIComponent(preset || 'last_30d')}`;
  const url = `${META_API}/${adId}/insights?fields=${fields}&${rangeParam}${extra}&access_token=${token}`;
  try {
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) {
      console.warn(`[ad-detail] insights ${adId} (${extra || 'base'}) error: ${j.error.message}`);
      return null;
    }
    return j.data || [];
  } catch (e) {
    console.warn(`[ad-detail] insights ${adId} fetch failed: ${e.message}`);
    return null;
  }
}

// Constrói o objeto `creative` do response a partir do raw da Meta
function buildCreativeFromRaw(raw) {
  if (!raw) return null;
  const c = raw.creative || {};
  const oss = c.object_story_spec || {};
  const link = oss.link_data || {};
  const video = oss.video_data || {};

  const isVideo = !!(c.video_id || video.video_id);
  const type = isVideo ? 'video' : (c.image_url || c.image_crops ? 'image' : 'unknown');

  // Texto: headline/body/cta podem vir de link_data, video_data ou do creative raiz
  const headline = link.name || video.title || c.title || null;
  const body = link.message || video.message || c.body || null;
  const cta = link.call_to_action?.type || video.call_to_action?.type || c.call_to_action_type || null;
  const destinationUrl = link.link || c.object_url || null;

  return {
    type,
    image_url_hd: pickHdImage(c),
    video_id: c.video_id || video.video_id || null,
    video_url: null,  // preenchido depois via metaFetchVideoThumbs se aplicável
    thumbnail_url: c.thumbnail_url || null,
    instagram_permalink_url: c.instagram_permalink_url || null,
    headline,
    body,
    cta,
    destination_url: destinationUrl,
  };
}

// Parse de uma linha de insights base → métricas
function parseMetricas(row) {
  if (!row) return null;
  const purchases = actVal(row.actions, 'omni_purchase');
  const revenue = actVal(row.action_values, 'omni_purchase');
  const spend_cents = cents(row.spend);
  return {
    spend_cents,
    revenue_cents: cents(revenue),
    roas: actVal(row.purchase_roas, 'omni_purchase'),
    purchases: purchases != null ? Math.round(purchases) : null,
    ctr: row.ctr != null ? Number(row.ctr) : null,
    cpm_cents: cents(row.cpm),
    cpc_cents: cents(row.cpc),
    impressions: row.impressions != null ? Number(row.impressions) : null,
    alcance_unico: row.reach != null ? Number(row.reach) : null,
    frequencia: row.frequency != null ? Number(row.frequency) : null,
    view_content: actVal(row.actions, 'omni_view_content'),
    add_to_cart: actVal(row.actions, 'omni_add_to_cart'),
    initiate_checkout: actVal(row.actions, 'omni_initiated_checkout'),
  };
}

function parseTendencia(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    date: r.date_start,
    spend_cents: cents(r.spend),
    revenue_cents: cents(actVal(r.action_values, 'omni_purchase')),
    roas: actVal(r.purchase_roas, 'omni_purchase'),
  }));
}

function parseDemografia(rowsAgeGender, rowsRegion) {
  const por_idade_genero = (rowsAgeGender || []).map((r) => ({
    age: r.age || null,
    gender: r.gender || null,
    spend_cents: cents(r.spend),
    purchases: (() => { const v = actVal(r.actions, 'omni_purchase'); return v != null ? Math.round(v) : null; })(),
    impressions: r.impressions != null ? Number(r.impressions) : null,
  }));
  const por_regiao = (rowsRegion || []).map((r) => ({
    region: r.region || null,
    spend_cents: cents(r.spend),
    purchases: (() => { const v = actVal(r.actions, 'omni_purchase'); return v != null ? Math.round(v) : null; })(),
    impressions: r.impressions != null ? Number(r.impressions) : null,
  }));
  return { por_idade_genero, por_regiao };
}

function parsePlacements(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    placement: [r.publisher_platform, r.platform_position].filter(Boolean).join(' / ') || null,
    publisher_platform: r.publisher_platform || null,
    platform_position: r.platform_position || null,
    spend_cents: cents(r.spend),
    impressions: r.impressions != null ? Number(r.impressions) : null,
  }));
}

/**
 * getAdDetail
 * @param {string} adId
 * @param {string} accountId — usado pra logs/futuro (validação de ownership já cabe no caller)
 * @param {string} preset
 * @returns {Promise<object>}
 */
export async function getAdDetail(adId, accountId, preset = 'last_30d') {
  if (!adId) return { ok: false, error: 'ad_id_required' };

  const cacheKey = `${adId}:${preset}`;
  const now = Date.now();
  const cached = DETAIL_CACHE.get(cacheKey);
  if (cached && (now - cached.fetched_at) < DETAIL_TTL_MS) {
    return cached.data;
  }

  const token = await readToken();
  if (!token) return { ok: false, error: 'sem_token' };

  // 6 chamadas em paralelo
  const settled = await Promise.allSettled([
    metaFetchAdCreative(adId, token),
    metaFetchAdInsights(adId, token, {
      preset,
      fields: 'spend,actions,action_values,ctr,cpm,cpc,reach,frequency,impressions,purchase_roas',
    }),
    metaFetchAdInsights(adId, token, {
      preset,
      fields: 'spend,actions,action_values,purchase_roas',
      extra: '&time_increment=1',
    }),
    metaFetchAdInsights(adId, token, {
      preset,
      fields: 'spend,actions,impressions',
      extra: '&breakdowns=age,gender',
    }),
    metaFetchAdInsights(adId, token, {
      preset,
      fields: 'spend,actions,impressions',
      extra: '&breakdowns=region',
    }),
    metaFetchAdInsights(adId, token, {
      preset,
      fields: 'spend,impressions',
      extra: '&breakdowns=publisher_platform,platform_position',
    }),
  ]);

  const [
    creativeRes,
    insightsBaseRes,
    tendenciaRes,
    demoAgeGenderRes,
    demoRegionRes,
    placementsRes,
  ] = settled.map((s) => (s.status === 'fulfilled' ? s.value : null));

  const creative = buildCreativeFromRaw(creativeRes);

  // Se for vídeo, tenta resolver a source (mp4) e o melhor thumbnail em paralelo.
  // Se a Meta não devolver `source` (comum, depende de permissão), video_url fica null
  // e o front cai no fallback de thumbnail HD + link "ver no Instagram".
  if (creative && creative.type === 'video' && creative.video_id) {
    const [videoSrc, videoThumb] = await Promise.all([
      metaFetchVideoSource(creative.video_id, token),
      metaFetchVideoThumbs(creative.video_id, token),
    ]);
    if (videoSrc?.source) creative.video_url = videoSrc.source;
    if (videoSrc?.permalink_url && !creative.instagram_permalink_url) {
      creative.instagram_permalink_url = videoSrc.permalink_url;
    }
    const bestThumb = videoThumb || videoSrc?.picture || null;
    if (bestThumb) {
      creative.thumbnail_url = bestThumb;
      if (!creative.image_url_hd) creative.image_url_hd = bestThumb;
    }
  }

  const adRaw = creativeRes || {};
  const ad = {
    ad_id: adId,
    ad_name: adRaw.name || null,
    status: adRaw.status || null,
    effective_status: adRaw.effective_status || null,
    campaign_id: adRaw.campaign?.id || null,
    campaign_name: adRaw.campaign?.name || null,
    adset_id: adRaw.adset?.id || null,
    adset_name: adRaw.adset?.name || null,
    creative,
  };

  const baseRow = Array.isArray(insightsBaseRes) ? insightsBaseRes[0] : null;
  const metricas = parseMetricas(baseRow);
  const tendencia = parseTendencia(tendenciaRes);
  const demografia = parseDemografia(demoAgeGenderRes, demoRegionRes);
  const placements = parsePlacements(placementsRes);

  const data = {
    ok: true,
    updated_at: new Date().toISOString(),
    preset,
    ad,
    metricas,
    tendencia,
    demografia,
    placements,
    // sinaliza chamadas que falharam pra debug
    _partial: {
      creative_ok: !!creativeRes,
      metricas_ok: !!baseRow,
      tendencia_ok: Array.isArray(tendenciaRes),
      demografia_ok: !!(demoAgeGenderRes || demoRegionRes),
      placements_ok: Array.isArray(placementsRes),
    },
  };

  DETAIL_CACHE.set(cacheKey, { data, fetched_at: now });
  console.log(`[ad-detail] adId=${adId} preset=${preset} cached=false partial=${JSON.stringify(data._partial)}`);
  return data;
}

/**
 * handleAdDetail
 * Handler do endpoint GET /api/ad-detail.
 * Recebe req, res e URLSearchParams. Faz lookup do slug → ad_account_id pro mapping.
 */
export async function handleAdDetail(req, res, query) {
  const slug = query.get('slug');
  const adId = query.get('ad_id');
  const preset = query.get('preset') || 'last_30d';

  if (!slug || !adId) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: false, error: 'slug_and_ad_id_required' }));
    return;
  }

  const client = await readMappingClientBySlug(slug);
  if (!client) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: false, error: 'cliente_nao_encontrado', slug }));
    return;
  }

  const data = await getAdDetail(adId, client.ad_account_id, preset);

  res.writeHead(data.ok ? 200 : 500, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data, null, 2));
}
