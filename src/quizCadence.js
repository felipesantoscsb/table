import { safeGet, safeSet, safeDel, safeKeys } from './redis.js';
import { sendOfficialTemplate } from './whatsappOfficial/sender.js';
import { registrarTemplateWhatsApp } from './hub/client.js';
import { normalizePhone, isBlocked } from './conversation/store.js';

const CHECK_INTERVAL_MS = 60 * 1000;
const CADENCE_TTL_SEC = 7 * 24 * 60 * 60;
const LOCK_TTL_SEC = 10 * 60;

export const QUIZ_CADENCE_ENABLED = process.env.QUIZ_CADENCE_ENABLED === 'true';

const STEPS = [
  {
    key: '1h',
    delayMs: Number(process.env.QUIZ_CADENCE_1H_DELAY_MS || 60 * 60 * 1000),
    templateName: process.env.QUIZ_CADENCE_1H_TEMPLATE || 'quiz_retomada_1h',
    params: (lead) => [firstName(lead.nome)],
  },
  {
    key: '24h',
    delayMs: Number(process.env.QUIZ_CADENCE_24H_DELAY_MS || 24 * 60 * 60 * 1000),
    templateName: process.env.QUIZ_CADENCE_24H_TEMPLATE || 'quiz_prova_24h',
    params: (lead) => [firstName(lead.nome), profileLabel(lead.perfil)],
  },
  {
    key: '72h',
    delayMs: Number(process.env.QUIZ_CADENCE_72H_DELAY_MS || 72 * 60 * 60 * 1000),
    templateName: process.env.QUIZ_CADENCE_72H_TEMPLATE || 'quiz_ultima_chamada_72h',
    params: (lead) => [firstName(lead.nome)],
  },
];

let isRunning = false;

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'você';
}

function profileLabel(perfil) {
  const p = String(perfil || '').trim().toLowerCase();
  if (p.includes('restritiva') || p === 'r') return 'restritivo';
  if (p.includes('sobreviv') || p === 's') return 'de sobrevivência';
  if (p.includes('desconectada') || p === 'a') return 'de desconexão';
  return 'emocional';
}

function quizScore(lead = {}) {
  let score = 50;
  if (lead.lead_event_id) score += 15;
  if (lead.tier === 'hot') score += 20;
  if (lead.tier === 'warm') score += 10;
  if (lead.perfil) score += 10;
  if (lead.respostas && String(lead.respostas).length > 120) score += 10;
  return Math.min(score, 100);
}

function dentroDoHorario() {
  const brasilia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dia = brasilia.getDay();
  const hora = brasilia.getHours();
  const fds = dia === 0 || dia === 6;
  if (fds) return hora >= 8 && hora < 17;
  return hora >= 8 && hora < 21;
}

function pendingKey(phone, stepIndex) {
  return `pending_quiz_cadence:${phone}:${stepIndex}`;
}

async function loadCadence(phone) {
  const raw = await safeGet(`quiz_cadence:${phone}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function saveCadence(phone, cadence) {
  await safeSet(`quiz_cadence:${phone}`, JSON.stringify(cadence), 'EX', CADENCE_TTL_SEC);
}

export async function scheduleQuizCadence(phoneRaw, leadData = {}) {
  if (!QUIZ_CADENCE_ENABLED) return;

  const phone = normalizePhone(phoneRaw || leadData.phone || leadData.whatsapp || '');
  if (!phone) return;

  const lead = {
    ...leadData,
    phone,
    score: leadData.score || quizScore(leadData),
    source: leadData.source || 'quiz',
  };
  const now = Date.now();

  await safeDel(`quiz_cadence_cancelled:${phone}`);
  for (const step of STEPS) {
    await safeDel(`quiz_cadence_sent:${phone}:${step.key}`);
  }

  await saveCadence(phone, {
    phone,
    lead,
    created_at: now,
    status: 'scheduled',
    score: lead.score,
    steps: STEPS.map((step, index) => ({
      index,
      key: step.key,
      templateName: step.templateName,
      fire_at: now + step.delayMs,
      status: 'pending',
    })),
  });

  for (let index = 0; index < STEPS.length; index++) {
    await safeSet(
      pendingKey(phone, index),
      JSON.stringify({ phone, stepIndex: index, fire_at: now + STEPS[index].delayMs }),
      'EX',
      CADENCE_TTL_SEC
    );
  }

  console.log(`🧭 [quiz-cadence] Cadência agendada para ${lead.nome || 'Lead'} (${phone}) — score ${lead.score}`);
}

export async function cancelQuizCadence(phoneRaw, reason = 'cancelled') {
  const phone = normalizePhone(phoneRaw || '');
  if (!phone) return;

  await safeDel(`quiz_cadence:${phone}`);
  await safeDel(`quiz_cadence_cancelled:${phone}`);
  await safeSet(`quiz_cadence_cancelled:${phone}`, reason, 'EX', CADENCE_TTL_SEC);

  const keys = await safeKeys(`pending_quiz_cadence:${phone}:*`);
  for (const key of keys) await safeDel(key);

  console.log(`🛑 [quiz-cadence] Cadência cancelada para ${phone} — ${reason}`);
}

export async function clearPendingQuizCadence() {
  const keys = [
    ...await safeKeys('pending_quiz_cadence:*'),
    ...await safeKeys('quiz_cadence:*'),
  ];
  for (const key of new Set(keys)) await safeDel(key);
  console.log(`🧹 [quiz-cadence] ${new Set(keys).size} chave(s) removida(s)`);
}

export function startQuizCadenceJob() {
  if (!QUIZ_CADENCE_ENABLED) {
    console.log('🛑 Cadência pós-quiz oficial desativada');
    return;
  }
  console.log('⏰ Cadência pós-quiz oficial ativada');
  setInterval(checkQuizCadence, CHECK_INTERVAL_MS);
}

export async function checkQuizCadence() {
  if (isRunning) return;
  isRunning = true;
  try {
    const keys = await safeKeys('pending_quiz_cadence:*');
    const now = Date.now();

    for (const key of keys) {
      const raw = await safeGet(key);
      if (!raw) continue;

      let pending;
      try { pending = JSON.parse(raw); } catch { continue; }

      if (!pending.fire_at || pending.fire_at > now) continue;
      if (!dentroDoHorario()) continue;

      await fireQuizCadenceStep(pending.phone, pending.stepIndex);
    }
  } finally {
    isRunning = false;
  }
}

export async function fireQuizCadenceStep(phoneRaw, stepIndex) {
  const phone = normalizePhone(phoneRaw || '');
  const step = STEPS[Number(stepIndex)];
  if (!phone || !step) return;

  if (await safeGet(`compra:${phone}`)) {
    await cancelQuizCadence(phone, 'purchase');
    return;
  }

  if (await safeGet(`quiz_cadence_cancelled:${phone}`)) {
    await safeDel(pendingKey(phone, stepIndex));
    return;
  }

  // Número bloqueado (/stop): encerra a cadência inteira, não só este step.
  if (await isBlocked(phone)) {
    await cancelQuizCadence(phone);
    console.log(`⛔ [quiz-cadence] cadência cancelada para ${phone} (número bloqueado)`);
    return;
  }

  const lock = await safeSet(`quiz_cadence_lock:${phone}:${stepIndex}`, '1', 'EX', LOCK_TTL_SEC, 'NX');
  if (!lock) return;

  try {
    const cadence = await loadCadence(phone);
    if (!cadence?.lead) {
      await safeDel(pendingKey(phone, stepIndex));
      return;
    }

    const alreadySent = await safeGet(`quiz_cadence_sent:${phone}:${step.key}`);
    if (alreadySent) {
      await safeDel(pendingKey(phone, stepIndex));
      return;
    }

    const params = step.params(cadence.lead);
    const provider = await sendOfficialTemplate({
      to: phone,
      templateName: step.templateName,
      params,
    });

    await registrarTemplateWhatsApp({
      leadData: {
        ...cadence.lead,
        source: cadence.lead.source || 'quiz-cadence',
        tier: cadence.lead.tier || `score_${cadence.score || ''}`,
      },
      phone,
      templateName: step.templateName,
      params,
      provider,
    });

    await safeSet(`quiz_cadence_sent:${phone}:${step.key}`, '1', 'EX', CADENCE_TTL_SEC);
    await safeDel(pendingKey(phone, stepIndex));

    cadence.steps = (cadence.steps || []).map((item) => (
      Number(item.index) === Number(stepIndex)
        ? { ...item, status: 'sent', sent_at: Date.now() }
        : item
    ));
    cadence.status = cadence.steps.some(item => item.status === 'pending') ? 'scheduled' : 'completed';
    await saveCadence(phone, cadence);

    console.log(`✅ [quiz-cadence] ${step.templateName} enviado para ${phone}`);
  } catch (err) {
    console.error(`❌ [quiz-cadence] Erro no step ${step.key} para ${phone}:`, err.message);
  } finally {
    await safeDel(`quiz_cadence_lock:${phone}:${stepIndex}`);
  }
}

export async function handleQuizCadenceCancel(req, res) {
  const secret = req.headers['x-webhook-secret'] || req.body?.secret;
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const phone = normalizePhone(req.body?.phone || req.body?.telefone || req.body?.whatsapp || '');
  if (!phone) return res.status(400).json({ error: 'Telefone obrigatório' });

  await cancelQuizCadence(phone, req.body?.reason || 'external');
  return res.json({ ok: true, phone });
}
