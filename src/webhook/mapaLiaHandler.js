// src/webhook/mapaLiaHandler.js
//
// Recebe leads do Mapa LIA (aquisicao-table) que concluíram o quiz e
// deixaram contato, mas ainda não assinaram. NÃO reaproveita nada do fluxo
// do Raiz (quiz:/pending_dossie:/lead_event_id) — namespace, templates e
// flags próprios, pra nunca competir ou se misturar com o Protocolo Raiz.
//
// Dois disparos, cada um atrás da própria flag (desligada por padrão — os
// templates ainda estavam em aprovação no Meta quando isto foi escrito):
//   - lia_rec:     +15min, com botão de URL dinâmica (link do mapa em
//                  evelynliu.com.br/l/:session_id)
//   - lia_entende: +3h, pergunta aberta, sem botão. Se a janela comercial
//                  ainda não abriu, o horário é ajustado UMA vez no
//                  agendamento (não recalculado a cada tentativa).

import { safeGet, safeSet, safeDel } from '../redis.js';
import { normalizePhone, isBlocked } from '../conversation/store.js';
import { sendOfficialTemplate } from '../whatsappOfficial/sender.js';
import { registrarTemplateWhatsApp } from '../hub/client.js';
import { wasRecentlyContacted, markOutboundSent } from '../outboundSuppression.js';

export const LIA_REC_ENABLED = process.env.LIA_REC_ENABLED === 'true';
export const LIA_ENTENDE_ENABLED = process.env.LIA_ENTENDE_ENABLED === 'true';

const LIA_REC_TEMPLATE = process.env.LIA_REC_TEMPLATE || 'lia_rec';
const LIA_ENTENDE_TEMPLATE = process.env.LIA_ENTENDE_TEMPLATE || 'lia_entende';

const REC_DELAY_MS = 15 * 60 * 1000;
const ENTENDE_BASE_DELAY_MS = 3 * 60 * 60 * 1000;
const PENDING_TTL_SEC = 24 * 60 * 60; // cobre agendamento empurrado p/ próxima janela

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'você';
}

// Mesma técnica (roundtrip via toLocaleString) já usada no disparo do Raiz
// (handler.js) — mantém consistência de estilo em vez de introduzir uma
// segunda forma de calcular horário de Brasília no mesmo repo.
function brasiliaAgora(ts = Date.now()) {
  return new Date(new Date(ts).toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function dentroDoHorario(ts = Date.now()) {
  const b = brasiliaAgora(ts);
  const dia = b.getDay();
  const hora = b.getHours();
  const fds = dia === 0 || dia === 6;
  return fds ? (hora >= 8 && hora < 17) : (hora >= 8 && hora < 21);
}

// Se o alvo (agora + delayMs) cai fora da janela comercial, empurra pro
// próximo horário de abertura (8h de Brasília). Calculado uma vez, no
// agendamento — não a cada tentativa de envio.
function ajustarParaJanela(delayMs) {
  const alvo = Date.now() + delayMs;
  if (dentroDoHorario(alvo)) return delayMs;

  const b = brasiliaAgora(alvo);
  const fds = b.getDay() === 0 || b.getDay() === 6;
  const fechaHora = fds ? 17 : 21;
  if (b.getHours() >= fechaHora) b.setDate(b.getDate() + 1);
  b.setHours(8, 0, 0, 0);

  const extraMs = b.getTime() - brasiliaAgora(alvo).getTime();
  return delayMs + extraMs;
}

export async function handleMapaLiaLead(req, res) {
  const secret = req.headers['x-webhook-secret'] || req.body?.secret;
  if (secret !== process.env.WEBHOOK_SECRET) {
    console.warn('⚠️ /webhook/mapa-lia: segredo inválido');
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const body = req.body || {};
  const nome = body.nome || 'você';
  const phone = normalizePhone(body.whatsapp || body.phone || '');
  const sessionId = body.session_id || null;

  if (!phone) {
    return res.status(400).json({ error: 'WhatsApp obrigatório' });
  }

  res.status(200).json({ received: true, phone });

  const leadData = { nome, phone, sessionId };

  if (LIA_REC_ENABLED) {
    const fire_at = Date.now() + REC_DELAY_MS;
    await safeSet(`pending_lia_rec:${phone}`, JSON.stringify({ phone, leadData, fire_at }), 'EX', PENDING_TTL_SEC);
    console.log(`⏳ [lia_rec] Agendado para ${nome} (${phone}) em 15 minutos`);
    setTimeout(() => fireLiaRec(leadData), REC_DELAY_MS);
  }

  if (LIA_ENTENDE_ENABLED) {
    const delay = ajustarParaJanela(ENTENDE_BASE_DELAY_MS);
    const fire_at = Date.now() + delay;
    await safeSet(`pending_lia_entende:${phone}`, JSON.stringify({ phone, leadData, fire_at }), 'EX', PENDING_TTL_SEC);
    console.log(`⏳ [lia_entende] Agendado para ${nome} (${phone}) em ${Math.round(delay / 60000)}min`);
    setTimeout(() => fireLiaEntende(leadData), delay);
  }
}

export async function fireLiaRec(leadData) {
  const { phone, nome, sessionId } = leadData;
  try {
    if (!LIA_REC_ENABLED) { await safeDel(`pending_lia_rec:${phone}`); return; }
    if (await isBlocked(phone)) {
      console.log(`⛔ [lia_rec] Cancelado para ${nome} (${phone}) — número bloqueado`);
      await safeDel(`pending_lia_rec:${phone}`);
      return;
    }
    if (await wasRecentlyContacted(phone)) {
      console.log(`⏭️ [lia_rec] Suprimido para ${nome} (${phone}) — já recebeu outro disparo recentemente`);
      await safeDel(`pending_lia_rec:${phone}`);
      return;
    }

    const params = [firstName(nome)];
    const buttonParams = sessionId ? [sessionId] : [];
    const provider = await sendOfficialTemplate({ to: phone, templateName: LIA_REC_TEMPLATE, params, buttonParams });
    await registrarTemplateWhatsApp({
      leadData: { nome, source: 'mapa-lia' },
      phone, templateName: LIA_REC_TEMPLATE, params: [...params, ...buttonParams], provider,
    });
    await markOutboundSent(phone);
    await safeDel(`pending_lia_rec:${phone}`);
    console.log(`✅ [lia_rec] Enviado para ${nome} (${phone})`);
  } catch (err) {
    console.error(`❌ [lia_rec] Erro para ${nome} (${phone}):`, err.message);
  }
}

export async function fireLiaEntende(leadData) {
  const { phone, nome } = leadData;
  try {
    if (!LIA_ENTENDE_ENABLED) { await safeDel(`pending_lia_entende:${phone}`); return; }
    if (await isBlocked(phone)) {
      console.log(`⛔ [lia_entende] Cancelado para ${nome} (${phone}) — número bloqueado`);
      await safeDel(`pending_lia_entende:${phone}`);
      return;
    }
    if (!dentroDoHorario()) {
      // Não deveria acontecer (o horário já foi ajustado no agendamento),
      // mas se um redeploy atrasar o recovery pra fora da janela, não força
      // envio de madrugada — fica pendente pro próximo recovery.
      console.log(`⏰ [lia_entende] Fora do horário — ${nome} (${phone}) permanece pendente`);
      return;
    }
    if (await wasRecentlyContacted(phone)) {
      console.log(`⏭️ [lia_entende] Suprimido para ${nome} (${phone}) — já recebeu outro disparo recentemente`);
      await safeDel(`pending_lia_entende:${phone}`);
      return;
    }

    const params = [firstName(nome)];
    const provider = await sendOfficialTemplate({ to: phone, templateName: LIA_ENTENDE_TEMPLATE, params });
    await registrarTemplateWhatsApp({
      leadData: { nome, source: 'mapa-lia' },
      phone, templateName: LIA_ENTENDE_TEMPLATE, params, provider,
    });
    await markOutboundSent(phone);
    await safeDel(`pending_lia_entende:${phone}`);
    console.log(`✅ [lia_entende] Enviado para ${nome} (${phone})`);
  } catch (err) {
    console.error(`❌ [lia_entende] Erro para ${nome} (${phone}):`, err.message);
  }
}
