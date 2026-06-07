// ──────────────────────────────────────────────────────────────────────────────
// social-cron.mjs — Worker do AGENDADOR SOCIAL (F1 / MVP) — DRY-RUN
//
// `runSocialCron(ctx)` é o entrypoint. A cada tick:
//   SELECT status='agendado' AND agendado_para <= now()
//   para cada publicação devida → SÓ LOGA o que publicaria.
//
// ⚠️ DRY_RUN=true: NÃO chama a Graph API, NÃO muda status, NÃO toca em nada.
// Quando DRY_RUN for false (FUTURO / F2+), o worker publicaria de verdade — mas
// essa implementação real NÃO existe ainda e NÃO deve ser adicionada aqui na F1.
//
// `ctx` = { supabase, logAuditEntry }
//
// Agendamento (no server.mjs):
//   import { runSocialCron } from './social-cron.mjs';
//   setInterval(() => runSocialCron({ supabase, logAuditEntry }).catch(console.error), 60_000);
// ──────────────────────────────────────────────────────────────────────────────

'use strict';

// Trava de segurança da F1. NÃO mude pra false sem implementar publicação real.
const DRY_RUN = true;

async function runSocialCron(ctx) {
  if (!ctx?.supabase) {
    console.log('[social-cron] supabase indisponível, abortando');
    return { ok: false, error: 'supabase_indisponivel' };
  }
  const { supabase, logAuditEntry } = ctx;

  const nowIso = new Date().toISOString();
  const { data: devidas, error } = await supabase
    .from('social_publicacoes')
    .select('id, cliente_slug, plataforma, formato, agendado_para')
    .eq('status', 'agendado')
    .lte('agendado_para', nowIso)
    .order('agendado_para', { ascending: true })
    .limit(50);

  if (error) {
    console.warn('[social-cron] erro ao buscar devidas:', error.message);
    return { ok: false, error: error.message };
  }

  const total = devidas?.length || 0;
  if (!total) return { ok: true, devidas: 0, dry_run: DRY_RUN };

  for (const p of devidas) {
    const msg = `DRY-RUN: publicaria ${p.id} ${p.plataforma} ${p.formato} em ${p.cliente_slug}`;
    console.log(`[social-cron] ${msg}`);
    // Registra no audit-log (best effort) — NÃO muda status.
    try {
      logAuditEntry?.({
        slug: p.cliente_slug,
        action: 'social_dry_run_publish',
        entity_type: 'social',
        entity_id: p.id,
        ok: true,
        dry_run: true,
        detail: msg,
      });
    } catch {}
  }

  if (!DRY_RUN) {
    // FUTURO (F2+): aqui entraria o claim com lock_expira_em + chamada à Graph API
    // (creation_id → media_id → publish) + transição de status. NÃO implementado na F1.
    console.warn('[social-cron] DRY_RUN=false mas publicação real não está implementada (F1).');
  }

  return { ok: true, devidas: total, dry_run: DRY_RUN };
}

export { runSocialCron, DRY_RUN };
