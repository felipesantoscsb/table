// src/disparos/handler.js

import { normalizePhone, isBlocked } from '../conversation/store.js';
import { safeSet, safeDel } from '../redis.js';
import { sendOfficialTemplate } from '../whatsappOfficial/sender.js';
import { registrarTemplateWhatsApp } from '../hub/client.js';

const PENDING_DOSSIE_TTL = 24 * 60 * 60; // 24h — cobre fora-de-horário

const DELAY_MS = 15 * 60 * 1000;
export const DOSSIE_WHATSAPP_ENABLED = process.env.DOSSIE_WHATSAPP_ENABLED === 'true';

const DOSSIE_TEMPLATE_BY_PROFILE = {
  E: 'dossie_emocional',
  R: 'dossie_restritiva',
  S: 'dossie_sobrevivencia',
  A: 'dossie_desconectada',
};
const DOSSIE_BUTTON_MODE = process.env.DOSSIE_BUTTON_MODE || 'static';

function resolverPerfil(perfil) {
  if (!perfil) return 'E';
  const p = perfil.toString().trim();
  if (['E', 'R', 'S', 'A'].includes(p.toUpperCase())) return p.toUpperCase();
  const lower = p.toLowerCase();
  if (lower.includes('emocional')) return 'E';
  if (lower.includes('restritiva')) return 'R';
  if (lower.includes('sobreviv')) return 'S';
  if (lower.includes('desconectada')) return 'A';
  const first = p[0].toUpperCase();
  if (['E', 'R', 'S', 'A'].includes(first)) return first;
  return 'E';
}

// Garante que respostas seja sempre um array de objetos {pergunta, resposta}
function parseRespostas(raw) {
  if (!raw) return [];

  // Já é array
  if (Array.isArray(raw)) return raw;

  // É string JSON
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // É texto puro, retorna como item único
      return [{ pergunta: 'Contexto', resposta: raw }];
    }
  }

  // É objeto único
  if (typeof raw === 'object') return [raw];

  return [];
}

function dentroDoHorario() {
  const brasilia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dia = brasilia.getDay();
  const hora = brasilia.getHours();
  const fds = dia === 0 || dia === 6;
  if (fds) return hora >= 8 && hora < 17;
  return hora >= 8 && hora < 21;
}

function msAteAbertura() {
  const brasilia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const hora = brasilia.getHours();
  const minuto = brasilia.getMinutes();
  const minutosAte8h = hora < 8
    ? (8 - hora) * 60 - minuto
    : (24 - hora + 8) * 60 - minuto;
  return minutosAte8h * 60 * 1000;
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'você';
}

export async function handleDisparo(req, res) {
  const secret = req.headers['x-webhook-secret'] || req.body.secret;
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const body = req.body;

  // Log bruto do payload para debug de mapeamento de campos
  console.log(`📨 Payload bruto recebido:`, JSON.stringify(body, null, 2));

  const nome     = body.nome || body.Nome || 'você';
  const phone    = normalizePhone(body.whatsapp || body.whats || '');
  const perfil   = resolverPerfil(body.perfil || body.profile || body.profileName || '');
  const historico = Array.isArray(body.historico) ? body.historico.join(', ') : body.historico || '';
  // Make envia as respostas no campo "Perguntas e respostas" (com espaço e acento)
  const respostasRaw = body['Perguntas e respostas'] || body.respostas || body['perguntas_e_respostas'] || '';
  const respostas  = parseRespostas(respostasRaw);
  const source        = body.source || '';
  const lead_event_id = body.lead_event_id || body.lid || null;
  const tier          = body.tier || null;

  if (!phone) {
    return res.status(400).json({ error: 'WhatsApp obrigatório' });
  }

  console.log(`📨 Disparo mapeado:
  Nome: ${nome}
  Phone: ${phone}
  Perfil original: "${body.perfil || body.profile}" → resolvido: ${perfil}
  Histórico: ${historico || 'vazio'}
  Respostas raw (campo): ${respostasRaw ? `"${String(respostasRaw).slice(0, 80)}..."` : 'vazio'}
  Respostas parseadas: ${respostas.length} itens
  Source: ${source}`);

  res.status(200).json({ received: true, phone, perfil });

  if (!DOSSIE_WHATSAPP_ENABLED) {
    await safeDel(`pending_dossie:${phone}`);
    console.log(`🛑 Disparo de dossiê pausado — ${nome} (${phone}) não será enfileirada`);
    return;
  }

  const delay = DELAY_MS;
  const fire_at = Date.now() + delay;

  await safeSet(
    `pending_dossie:${phone}`,
    JSON.stringify({ phone, leadData: { nome, perfil, historico, respostas, source, lead_event_id, tier }, scheduled_at: Date.now(), fire_at }),
    'EX', PENDING_DOSSIE_TTL
  );

  if (dentroDoHorario()) {
    console.log(`⏳ Disparo agendado para ${nome} em 15 minutos`);
  } else {
    console.log(`⏰ Fora do horário — disparo para ${nome} em ${Math.round(delay / 60000)} minutos`);
  }
  setTimeout(() => fireDossie({ nome, phone, perfil, historico, respostas, source, lead_event_id, tier }), delay);
}

/**
 * Envia o dossiê imediatamente (sem agendamento).
 * Chamado pelo setTimeout e pela recovery de redeploy.
 */
export async function fireDossie({ nome, phone, perfil, historico, respostas, source, lead_event_id, tier }) {
  try {
    if (!DOSSIE_WHATSAPP_ENABLED) {
      await safeDel(`pending_dossie:${phone}`);
      console.log(`🛑 Disparo de dossiê pausado — pendência removida para ${nome} (${phone})`);
      return;
    }

    if (await isBlocked(phone)) {
      await safeDel(`pending_dossie:${phone}`);
      console.log(`⛔ Disparo de dossiê cancelado para ${nome} (${phone}) — número bloqueado`);
      return;
    }

    const templateName = DOSSIE_TEMPLATE_BY_PROFILE[perfil] || DOSSIE_TEMPLATE_BY_PROFILE.E;
    const params = [firstName(nome)];
    const buttonParams = DOSSIE_BUTTON_MODE === 'dynamic' && lead_event_id
      ? [lead_event_id]
      : [];
    console.log(`📨 Enviando dossiê oficial para ${nome} (${phone}) — perfil ${perfil}, template ${templateName}`);
    const provider = await sendOfficialTemplate({
      to: phone,
      templateName,
      params,
      buttonParams,
    });
    await registrarTemplateWhatsApp({
      leadData: { nome, source, tier },
      phone,
      templateName,
      params: [...params, ...buttonParams],
      provider,
    });
    await safeDel(`pending_dossie:${phone}`);
    console.log(`✅ Dossiê oficial enviado para ${nome} (${phone})`);
  } catch (err) {
    console.error(`❌ Erro no disparo para ${nome} (${phone}):`, err.message);
    console.error(err.stack);
  }
}

/**
 * Agenda envio de dossiê para um lead sem passar por req/res.
 * Usado internamente pelo fluxo de quiz.
 */
export async function scheduleDisparo({ nome, phone, perfil: perfilRaw, historico: historicoRaw, respostas: respostasRaw, source: src, lead_event_id, tier }) {
  const perfil    = resolverPerfil(perfilRaw || '');
  const historico = Array.isArray(historicoRaw) ? historicoRaw.join(', ') : (historicoRaw || '');
  const respostas = parseRespostas(respostasRaw);
  const source    = src || '';

  if (!DOSSIE_WHATSAPP_ENABLED) {
    await safeDel(`pending_dossie:${phone}`);
    console.log(`🛑 [quiz] Disparo de dossiê pausado — ${nome} (${phone}) não será enfileirada`);
    return;
  }

  const delay   = DELAY_MS;
  const fire_at = Date.now() + delay;

  await safeSet(
    `pending_dossie:${phone}`,
    JSON.stringify({ phone, leadData: { nome, perfil, historico, respostas, source, lead_event_id, tier }, scheduled_at: Date.now(), fire_at }),
    'EX', PENDING_DOSSIE_TTL
  );

  if (dentroDoHorario()) {
    console.log(`⏳ [quiz] Disparo agendado para ${nome} em 15 minutos`);
  } else {
    console.log(`⏰ [quiz] Fora do horário — disparo para ${nome} em ${Math.round(delay / 60000)} minutos`);
  }
  setTimeout(() => fireDossie({ nome, phone, perfil, historico, respostas, source, lead_event_id, tier }), delay);
}
