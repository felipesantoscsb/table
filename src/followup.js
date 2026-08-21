// src/followup.js
//
// Job que roda a cada 1 min e processa follow-up 6h para leads do quiz.
// Varre keys "quiz:{phone}" no Redis — NÃO toca em "lead:{phone}" (formulário).

import { safeGet, safeSet, safeDel, safeKeys } from './redis.js';
import { sendMessage } from './zapi/sender.js';
import { generateFollowUpContact } from './ai/anthropic.js';
import { activateLead, addMessage, enqueueMessage, isBlocked } from './conversation/store.js';

const FOLLOWUP_DELAY_MS  = 6 * 60 * 60 * 1000; // 6 horas
const TRACK_TTL_SEC      = 7  * 24 * 60 * 60;   // 7 dias
const PENDING_TTL_SEC    = 7  * 24 * 60 * 60;   // 7 dias
const CHECK_INTERVAL_MS  = 60 * 1000;            // verificar a cada 1 min

const BASE_URL = process.env.BASE_URL || 'https://estrutura-table-production.up.railway.app';
export const FOLLOWUP_6H_ENABLED = process.env.FOLLOWUP_6H_ENABLED === 'true';

// Horário comercial (America/Sao_Paulo): seg–sex 8h–21h, sáb–dom 8h–17h
export function dentroDoHorario() {
  const brasilia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dia = brasilia.getDay();
  const hora = brasilia.getHours();
  const fds = dia === 0 || dia === 6;
  if (fds) return hora >= 8 && hora < 17;
  return hora >= 8 && hora < 21;
}

export function startFollowUpJob() {
  if (!FOLLOWUP_6H_ENABLED) {
    console.log('🛑 Job de follow-up 6h desativado');
    return;
  }
  console.log('⏰ Job de follow-up 6h ativado');
  setInterval(checkFollowUps, CHECK_INTERVAL_MS);
}

/**
 * Remove filas antigas para impedir que leads acumuladas sejam disparadas
 * caso o recurso seja reativado no futuro.
 */
export async function clearPendingFollowUps() {
  const keys = [
    ...await safeKeys('pending_followup:*'),
    ...await safeKeys('followup_processing:*'),
    ...await safeKeys('quiz:*'),
  ];
  for (const key of new Set(keys)) await safeDel(key);

  // Remove também primeiras mensagens já geradas fora do horário comercial.
  let queuedRemoved = 0;
  for (const queueKey of await safeKeys('queue:*')) {
    const phone = queueKey.replace('queue:', '');
    const rawConv = await safeGet(`conv:${phone}`);
    if (!rawConv) continue;
    let conv;
    try { conv = JSON.parse(rawConv); } catch { continue; }
    if (conv.leadData?.source !== 'quiz-followup-6h') continue;
    await safeDel(queueKey);
    await safeDel(`conv:${phone}`);
    await safeDel(`lastseen:${phone}`);
    queuedRemoved++;
  }

  console.log(
    `🧹 Follow-up 6h desativado — ${new Set(keys).size} fila(s) pendente(s) e ${queuedRemoved} mensagem(ns) agendada(s) removida(s)`
  );
}

// Evita ticks sobrepostos do cron (não-reentrante)
let isRunning = false;

async function checkFollowUps() {
  if (isRunning) return;
  isRunning = true;
  try {
    const keys = await safeKeys('quiz:*');
    if (!keys.length) return;

    const now = Date.now();

    for (const key of keys) {
      const raw = await safeGet(key);
      if (!raw) continue;

      let lead;
      try { lead = JSON.parse(raw); } catch { continue; }

      const phone = lead.phone || key.replace('quiz:', '');
      if (!phone) continue;

      // Só processa leads com 6h+
      if (!lead.timestamp || now - lead.timestamp < FOLLOWUP_DELAY_MS) continue;

      // Já comprou?
      const compra = await safeGet(`compra:${phone}`);
      if (compra) {
        console.log(`🛒 [quiz] Lead ${lead.nome} (${phone}) já comprou — cancelando follow-up`);
        await safeDel(key);
        await safeDel(`pending_followup:${phone}`);
        continue;
      }

      // Já enviou follow-up?
      const jaEnviou = await safeGet(`followup:${phone}`);
      if (jaEnviou) {
        await safeDel(`pending_followup:${phone}`);
        continue;
      }

      // Fora do horário comercial? Mantém na fila (quiz:* persiste) e
      // o cron reprocessa no próximo horário válido — nunca de madrugada.
      if (!dentroDoHorario()) continue;

      await sendFollowUp(lead, phone);
      await safeDel(key); // remove da fila após processar
    }
  } finally {
    isRunning = false;
  }
}

/**
 * Envia o follow-up imediatamente.
 * Chamado pelo cron e pela recovery de redeploy.
 */
export async function fireFollowUp(lead, phone) {
  if (!FOLLOWUP_6H_ENABLED) return;
  // Revalida o guard no MOMENTO do disparo (não só no boot da recovery)
  if (await safeGet(`followup:${phone}`)) return;
  await sendFollowUp(lead, phone);
}

async function sendFollowUp(lead, phone) {
  // ── Guards rápidos ──────────────────────────────────────────────────────────
  if (await isBlocked(phone)) {
    console.log(`⛔ [quiz] ${phone} bloqueado — follow-up cancelado`);
    await safeDel(`pending_followup:${phone}`);
    return;
  }
  if (await safeGet(`compra:${phone}`)) {
    console.log(`🛒 [quiz] ${phone} já comprou — follow-up cancelado`);
    return;
  }
  if (await safeGet(`followup:${phone}`)) {
    console.log(`↩️  [quiz] follow-up de ${phone} já disparado — ignorando`);
    return;
  }

  // 1. Lock atômico ANTES do trabalho lento (substitui o set tardio).
  //    ioredis: SET key '1' EX 86400 NX → retorna 'OK' se gravou, null se já existia.
  //    (equivale ao { NX: true, EX: 86400 } do node-redis)
  const acquired = await safeSet(`followup:${phone}`, '1', 'EX', 86400, 'NX');
  if (!acquired) return;

  // 2. Lock de execução com TTL curto (segunda camada contra concorrência)
  const processing = await safeSet(`followup_processing:${phone}`, '1', 'EX', 30, 'NX');
  if (!processing) return;

  try {
    // Monta leadData compatível com generateFirstContact (mesmo formato do makeHandler)
    const leadData = {
      nome:        lead.nome || 'você',
      phone,
      whatsapp:    lead.whatsapp || phone,
      whats:       lead.whatsapp || phone,
      qualificacao: lead.perfil || lead.profileName || null,
      perfil:      lead.perfil || lead.profileName || '',
      historico:   lead.historico || '',
      dores:       lead.respostas || '',
      source:      lead.source || 'quiz-followup-6h',
    };

    const result = await generateFollowUpContact(leadData);

    leadData._monitorarDePerto = result.orientacao?.monitorarDePerto || false;
    leadData._avisoNatalia = result.avisoNatalia || false;

    // Ativa o agente SDR para esta lead (conv:{phone})
    await activateLead(phone, leadData);
    await addMessage(phone, 'assistant', result.leadMessage);

    if (dentroDoHorario()) {
      await sendMessage(phone, result.leadMessage);
    } else {
      // Mesmo padrão do makeHandler: enfileira a 1ª mensagem para a abertura
      await enqueueMessage(phone, `__PRIMEIRA_MENSAGEM__${result.leadMessage}`);
    }

    await safeDel(`pending_followup:${phone}`);
    console.log(`🤝 [quiz] Agente SDR iniciado via follow-up 6h para ${leadData.nome} (${phone})`);
  } catch (err) {
    console.error(`❌ [quiz] Erro no follow-up de ${phone}:`, err.message);
  } finally {
    // Garante limpeza do lock de execução mesmo em erro
    await safeDel(`followup_processing:${phone}`);
  }
}

/**
 * Salva pending_followup:{phone} no Redis.
 * Chamado pelo quizHandler ao receber um lead.
 */
export async function savePendingFollowup(phone, leadData) {
  if (!FOLLOWUP_6H_ENABLED) return;
  const fire_at = (leadData.timestamp || Date.now()) + FOLLOWUP_DELAY_MS;
  await safeSet(
    `pending_followup:${phone}`,
    JSON.stringify({ phone, leadData, scheduled_at: Date.now(), fire_at }),
    'EX', PENDING_TTL_SEC
  );
}
