// src/conversation/store.js

import { safeGet, safeSet, safeDel, safeRpush, safeLrange, safeKeys, safeExpire } from '../redis.js';

export const TURN_LIMIT = 15;

const PREFIX = {
  conv: 'conv:',
  queue: 'queue:',
  lastSeen: 'lastseen:',
  blocked: 'blocked:',
};

// Normaliza número para formato consistente
// Garante que números brasileiros com 8 dígitos locais ficam com 9
export function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, '');
  // Número BR com DDD: 55 + 2 dígitos DDD + 8 dígitos = 12 dígitos
  // Adiciona o 9 se necessário
  if (digits.startsWith('55') && digits.length === 12) {
    return digits.slice(0, 4) + '9' + digits.slice(4);
  }
  return digits;
}

// Bloqueio permanente por número (opt-out). Diferente de handedOff, que é por
// conversa e volta a false em toda reativação (activateLead / setRecoveryMode):
// o bloqueio sobrevive a novos gatilhos de quiz, formulário e recuperação de
// checkout, e não expira. Só sai com /unstop.
export async function blockPhone(phone) {
  await safeSet(PREFIX.blocked + normalizePhone(phone), String(Date.now()));
}

export async function unblockPhone(phone) {
  await safeDel(PREFIX.blocked + normalizePhone(phone));
}

export async function isBlocked(phone) {
  if (!phone) return false;
  return Boolean(await safeGet(PREFIX.blocked + normalizePhone(phone)));
}

async function getConv(phone) {
  const key = PREFIX.conv + normalizePhone(phone);
  const raw = await safeGet(key);
  return raw ? JSON.parse(raw) : {
    messages: [],
    isActiveLead: false,
    leadData: null,
    handedOff: false,
    turnCount: 0,
  };
}

async function saveConv(phone, conv) {
  const key = PREFIX.conv + normalizePhone(phone);
  await safeSet(key, JSON.stringify(conv));
}

export async function addMessage(phone, role, content) {
  const conv = await getConv(phone);
  conv.messages.push({ role, content });
  if (conv.messages.length > 50) conv.messages = conv.messages.slice(-50);
  await saveConv(phone, conv);
}

export async function activateLead(phone, leadData) {
  if (await isBlocked(phone)) {
    console.log(`⛔ Ativação ignorada: ${normalizePhone(phone)} está bloqueado`);
    return;
  }
  const conv = await getConv(phone);
  conv.isActiveLead = true;
  conv.leadData = leadData;
  conv.handedOff = false;
  conv.turnCount = 0;
  await saveConv(phone, conv);
  await safeSet(PREFIX.lastSeen + normalizePhone(phone), Date.now());
}

export async function deactivateLead(phone) {
  const normalized = normalizePhone(phone);
  await safeDel(PREFIX.conv + normalized);
  await safeDel(PREFIX.queue + normalized);
  await safeDel(PREFIX.lastSeen + normalized);
}

export async function isActiveLead(phone) {
  const conv = await getConv(phone);
  return conv.isActiveLead;
}

export async function getHistory(phone) {
  const conv = await getConv(phone);
  return conv.messages;
}

export async function getLeadData(phone) {
  const conv = await getConv(phone);
  return conv.leadData;
}

export async function getCommercialState(phone) {
  const conv = await getConv(phone);
  return conv.commercial || { branch: 'table', stage: 'default', signals: [] };
}

export async function setCommercialState(phone, patch) {
  const conv = await getConv(phone);
  conv.commercial = { ...(conv.commercial || { branch:'table',stage:'default',signals:[] }), ...(patch || {}), updatedAt:new Date().toISOString() };
  await saveConv(phone, conv);
  return conv.commercial;
}

// Modo da conversa: 'sdr' (padrão) ou 'recovery' (recuperação de checkout).
// No modo recovery o agente usa o prompt de recuperação e NUNCA agenda
// pré-consulta — foco é fechar a venda do Protocolo Raiz.
export async function getConversationMode(phone) {
  const conv = await getConv(phone);
  return conv.mode || 'sdr';
}

// Ativa a conversa em modo recovery para que as respostas da lead sejam
// conduzidas pelo prompt de recuperação. Preserva leadData existente e mescla
// os dados do checkout (pix/link) recebidos do aquisicao-table.
export async function setRecoveryMode(phone, leadData) {
  if (await isBlocked(phone)) {
    console.log(`⛔ Recovery ignorado: ${normalizePhone(phone)} está bloqueado`);
    return;
  }
  const conv = await getConv(phone);
  conv.isActiveLead = true;
  conv.handedOff = false;
  conv.mode = 'recovery';
  conv.leadData = { ...(conv.leadData || {}), ...(leadData || {}) };
  await saveConv(phone, conv);
  await safeSet(PREFIX.lastSeen + normalizePhone(phone), Date.now());
}

export async function isHandedOff(phone) {
  const conv = await getConv(phone);
  return conv.handedOff;
}

export async function setHandedOff(phone) {
  const conv = await getConv(phone);
  conv.handedOff = true;
  await saveConv(phone, conv);
}

export async function incrementTurn(phone) {
  const conv = await getConv(phone);
  conv.turnCount += 1;
  await saveConv(phone, conv);
  await safeSet(PREFIX.lastSeen + normalizePhone(phone), Date.now());
}

export async function getTurnCount(phone) {
  const conv = await getConv(phone);
  return conv.turnCount;
}

export async function enqueueMessage(phone, message) {
  const key = PREFIX.queue + normalizePhone(phone);
  await safeRpush(key, message);
  await safeExpire(key, 86400);
  console.log(`📥 Mensagem enfileirada para ${phone}`);
}

export async function dequeueMessages(phone) {
  const key = PREFIX.queue + normalizePhone(phone);
  const messages = await safeLrange(key, 0, -1);
  await safeDel(key);
  return messages;
}

export async function getPhonesWithQueue() {
  const keys = await safeKeys(PREFIX.queue + '*');
  return keys.map(k => k.replace(PREFIX.queue, ''));
}

export async function getInactiveLeads(maxAgeMs) {
  const keys = await safeKeys(PREFIX.lastSeen + '*');
  const now = Date.now();
  const inactive = [];

  for (const key of keys) {
    const ts = await safeGet(key);
    if (ts && (now - parseInt(ts)) > maxAgeMs) {
      const phone = key.replace(PREFIX.lastSeen, '');
      const conv = await getConv(phone);
      if (conv.isActiveLead && !conv.handedOff) {
        inactive.push({ phone, leadData: conv.leadData, lastSeen: parseInt(ts) });
      }
    }
  }

  return inactive;
}

export async function markFollowUpSent(phone) {
  await safeSet(PREFIX.lastSeen + normalizePhone(phone), Date.now());
}

// Histórico consultivo da Karina (memória, não precisa persistir)
const sdrHistory = [];

export function getSdrHistory() {
  return [...sdrHistory];
}

export function addSdrMessage(role, content) {
  sdrHistory.push({ role, content });
  if (sdrHistory.length > 30) sdrHistory.splice(0, sdrHistory.length - 30);
}
