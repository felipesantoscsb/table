import { getRedis, safeSet } from '../redis.js';
import { setHandedOff } from '../conversation/store.js';
import { notifyManualHandoffBatch } from '../zapi/sender.js';

function isNataliaSource(leadData = {}) {
  const fields = [
    leadData.source,
    leadData.origin,
    leadData.event_source_url,
    leadData.url,
    leadData.slug,
    leadData.campaign,
    leadData.utm?.source,
    leadData.utm?.campaign,
    leadData.utm_source,
    leadData.utm_campaign,
  ].filter(Boolean).map(v => String(v).toLowerCase());

  return fields.some(v => v.includes('natalia') || v.includes('natália') || v.includes('kelm'));
}

function manualSourceMatches(leadData) {
  return isNataliaSource(leadData);
}

function leadStatus(conv) {
  const messages = Array.isArray(conv.messages) ? conv.messages : [];
  const userMessages = messages.filter(m => m.role === 'user').length;
  const turnCount = conv.turnCount || 0;
  if (userMessages) return `${userMessages} resposta(s) da lead, ${turnCount} turno(s)`;
  return 'sem resposta da lead ainda';
}

function lastUserMessage(conv) {
  const messages = Array.isArray(conv.messages) ? conv.messages : [];
  return messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
}

async function ensureRedisConnected(redis) {
  if (redis.status === 'ready') return;
  if (redis.status === 'wait') {
    await redis.connect();
    return;
  }

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Redis não conectado: ${redis.status}`)), 5000);
    redis.once('ready', () => {
      clearTimeout(timeout);
      resolve();
    });
    redis.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function scanConversationKeys() {
  const redis = getRedis();
  await ensureRedisConnected(redis);
  let cursor = '0';
  const keys = [];
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', 'conv:*', 'COUNT', 1000);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

export async function collectManualHandoffLeads(options = {}) {
  const {
    onlyPending = true,
    skipAlreadyReemitted = true,
    limit = 50,
  } = options;

  const redis = getRedis();
  await ensureRedisConnected(redis);
  const keys = await scanConversationKeys();
  const leads = [];

  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;

    let conv;
    try { conv = JSON.parse(raw); } catch { continue; }

    const leadData = conv.leadData || {};
    if (!manualSourceMatches(leadData)) continue;
    if (onlyPending && conv.handedOff === true) continue;

    const phone = key.replace(/^conv:/, '');
    if (skipAlreadyReemitted && await redis.get(`manual_handoff_reemit:${phone}`)) continue;

    leads.push({
      phone,
      nome: leadData.nome || leadData.name || 'Lead',
      source: leadData.source || '',
      status: leadStatus(conv),
      lastUser: lastUserMessage(conv),
      userMessages: Array.isArray(conv.messages) ? conv.messages.filter(m => m.role === 'user').length : 0,
      turnCount: conv.turnCount || 0,
    });
  }

  leads.sort((a, b) =>
    b.userMessages - a.userMessages
    || b.turnCount - a.turnCount
    || String(a.nome).localeCompare(String(b.nome), 'pt-BR')
  );

  return leads.slice(0, limit);
}

export async function reemitManualHandoffs(options = {}) {
  const {
    dryRun = false,
    limit = 50,
  } = options;

  const leads = await collectManualHandoffLeads({
    onlyPending: true,
    skipAlreadyReemitted: true,
    limit,
  });

  if (!leads.length) return { sent: false, count: 0, leads };

  if (!dryRun) {
    await notifyManualHandoffBatch({
      title: '⚠️ *Leads Natália para ativação manual*',
      leads,
    });

    const payload = JSON.stringify({ sent_at: new Date().toISOString(), source: 'manual_reemit' });
    for (const lead of leads) {
      await setHandedOff(lead.phone);
      await safeSet(`manual_handoff_reemit:${lead.phone}`, payload, 'EX', 30 * 24 * 60 * 60);
    }
  }

  return { sent: !dryRun, count: leads.length, leads };
}
