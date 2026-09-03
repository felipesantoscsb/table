// src/zapi/sender.js

import axios from 'axios';
import { config } from '../../config/index.js';
import { getLeadData, isBlocked, normalizePhone } from '../conversation/store.js';

// Anexa a join key (sck = lead_event_id do quiz) aos links da Cakto na mensagem,
// para que a compra feita por esse link seja atribuível ao anúncio via CAPI
// (o webhook Cakto devolve data.sck → enrichFromLid puxa o fbc do lead). Sem
// lead_event_id conhecido, o link segue sem sck — mesmo comportamento de antes.
async function withCaktoSck(phone, message) {
  try {
    if (!/pay\.cakto\.com\.br\//.test(message)) return message;
    const lead = await getLeadData(phone);
    const sck = lead && lead.lead_event_id;
    if (!sck) return message;
    return message.replace(/https:\/\/pay\.cakto\.com\.br\/[A-Za-z0-9_]+(\?[^\s]*)?/g, function (url) {
      if (/[?&]sck=/.test(url)) return url; // já tem sck
      return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'sck=' + encodeURIComponent(sck);
    });
  } catch {
    return message;
  }
}

const zapiClient = axios.create({
  baseURL: config.zapi.baseUrl(),
  headers: {
    'Content-Type': 'application/json',
    'Client-Token': config.zapi.clientToken,
  },
});

function typingDelay(message) {
  const len = message.length;
  if (len <= 80)  return Math.floor(Math.random() * (12000 - 8000) + 8000);
  if (len <= 200) return Math.floor(Math.random() * (25000 - 15000) + 15000);
  return Math.floor(Math.random() * (45000 - 30000) + 30000);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendToAll(message, options = {}) {
  await sendMessage(config.sdr.phone, message, options);
  if (process.env.NUMERO_BACKUP) {
    await sendMessage(process.env.NUMERO_BACKUP, message, options);
  }
}

// A Karina e o número de backup nunca são silenciados pelo blocklist: são o
// canal de notificação (handoff, red flag, erro). Bloqueá-los por engano
// derrubaria a operação inteira em silêncio.
function isProtectedPhone(phone) {
  const alvo = normalizePhone(String(phone || ''));
  return [config.sdr.phone, process.env.NUMERO_BACKUP]
    .filter(Boolean)
    .some(p => normalizePhone(String(p)) === alvo);
}

export async function sendMessage(phone, message, options = {}) {
  try {
    // Último guard antes do envio: cobre qualquer caminho (agente, follow-up,
    // disparo, recuperação de checkout) sem depender de cada chamador lembrar.
    if (!isProtectedPhone(phone) && await isBlocked(phone)) {
      console.log(`⛔ Envio cancelado para ${phone} (número bloqueado)`);
      return null;
    }
    const outgoing = await withCaktoSck(phone, message);
    if (!options.skipDelay) {
      const delay = typingDelay(outgoing);
      console.log(`⏳ Aguardando ${Math.round(delay/1000)}s antes de enviar para ${phone}`);
      await sleep(delay);
    }
    const response = await zapiClient.post('/send-text', { phone, message: outgoing });
    console.log(`✅ Mensagem enviada para ${phone}`);
    return response.data;
  } catch (error) {
    const detail = error.response?.data || error.message;
    console.error(`❌ Erro ao enviar para ${phone}:`, detail);
    throw error;
  }
}

export async function notifySDR(leadData, sdrBriefing) {
  const cleanPhone = (leadData.whatsapp || leadData.whats || '').replace(/\D/g, '');
  const score = leadData.qualificacao?.score ?? leadData.score ?? '?';
  const tier = (leadData.qualificacao?.tier || leadData.temperatura || '').toUpperCase();
  const monitorar = leadData._monitorarDePerto;
  const avisoNatalia = leadData._avisoNatalia;

  const lines = [
    `🎯 *NOVO LEAD ATIVADO*`,
    ``,
    avisoNatalia ? `⚠️ *LEAD DA NATÁLIA KELM*\nPré-consulta com a Natália. Não ofereça o Protocolo Raiz.\n` : null,
    monitorar ? `🔴 *MONITORAR DE PERTO*\n` : null,
    `👤 *${leadData.nome}*`,
    `🌡️ ${tier} | Score: ${score}/10`,
    ``,
    `📊 *Briefing:*`,
    sdrBriefing,
    ``,
    `🔗 https://wa.me/${cleanPhone}`,
  ].filter(l => l !== null);

  await sendToAll(lines.join('\n'), { skipDelay: true });
}

export async function notifySDRHandoff(leadData, turno, handoffBriefing) {
  const cleanPhone = (leadData.whatsapp || leadData.whats || '').replace(/\D/g, '');
  const score = leadData.qualificacao?.score ?? leadData.score ?? '?';
  const tier = (leadData.qualificacao?.tier || leadData.temperatura || '').toUpperCase();

  const lines = [
    `🟢 *HANDOFF — PRONTA PARA AGENDAR*`,
    ``,
    `👤 *${leadData.nome}* | ${tier} | Score: ${score}/10`,
    `🕐 Turno preferido: *${turno}*`,
    ``,
    `📋 *Resumo da conversa:*`,
    handoffBriefing,
    ``,
    `🔗 https://wa.me/${cleanPhone}`,
  ];

  await sendToAll(lines.join('\n'), { skipDelay: true });
}

export async function notifySDRRedflag(leadData, motivo) {
  const cleanPhone = (leadData.whatsapp || leadData.whats || '').replace(/\D/g, '');

  const lines = [
    `🚨 *RED FLAG — ATENÇÃO IMEDIATA*`,
    ``,
    `👤 *${leadData.nome}*`,
    `🔗 https://wa.me/${cleanPhone}`,
    ``,
    `⚠️ *Motivo:* ${motivo}`,
    ``,
    `O agente parou de responder. Assuma a conversa com cuidado.`,
  ];

  await sendToAll(lines.join('\n'), { skipDelay: true });
}

export async function notifySDRTurnLimit(leadData, handoffBriefing) {
  const cleanPhone = (leadData.whatsapp || leadData.whats || '').replace(/\D/g, '');
  const score = leadData.qualificacao?.score ?? leadData.score ?? '?';
  const tier = (leadData.qualificacao?.tier || leadData.temperatura || '').toUpperCase();

  const lines = [
    `🛑 *TETO DE TURNOS ATINGIDO*`,
    ``,
    `👤 *${leadData.nome}* | ${tier} | Score: ${score}/10`,
    ``,
    `📋 *Resumo da conversa:*`,
    handoffBriefing,
    ``,
    `O agente pausou após 15 trocas. Assuma a conversa.`,
    `🔗 https://wa.me/${cleanPhone}`,
  ];

  await sendToAll(lines.join('\n'), { skipDelay: true });
}

export async function notifyManualHandoffBatch({ title, leads }) {
  const lines = [
    title || `⚠️ *Leads para ativação manual*`,
    ``,
    `Total: ${leads.length}`,
    ``,
  ];

  leads.forEach((lead, idx) => {
    const cleanPhone = String(lead.phone || lead.whatsapp || lead.whats || '').replace(/\D/g, '');
    lines.push(`${idx + 1}. *${lead.nome || lead.name || 'Lead'}*`);
    if (lead.source) lines.push(`Fonte: ${lead.source}`);
    if (lead.status) lines.push(`Status: ${lead.status}`);
    if (lead.lastUser) lines.push(`Última resposta: "${String(lead.lastUser).slice(0, 240)}"`);
    if (cleanPhone) lines.push(`🔗 https://wa.me/${cleanPhone}`);
    lines.push('');
  });

  await sendToAll(lines.join('\n'), { skipDelay: true });
}

// ── Campanha sazonal (Lista VIP Evelyn Liu) ──────────────────────────────────

function campanhaCleanPhone(participant) {
  return String(participant?.phone || participant?.telefone || '').replace(/\D/g, '');
}

// Handoff principal: lead respondeu positivamente. Se a campanha já encerrou
// (closed), vira aviso interno SEM prometer disponibilidade.
export async function notifyKarinaCampanhaHandoff(participant, text, { closed } = {}) {
  const nome = participant?.nome || 'Lead';
  const phone = campanhaCleanPhone(participant);
  const link = phone ? `🔗 https://wa.me/${phone}` : '';

  if (closed) {
    const lines = [
      `⚠️ *LISTA VIP EVELYN LIU — RESPOSTA APÓS ENCERRAMENTO*`,
      ``,
      `👤 *${nome}*`,
      `💬 Resposta: "${String(text || '').slice(0, 280)}"`,
      ``,
      `As 3 vagas já foram preenchidas. *Não prometa disponibilidade.*`,
      `Se fizer sentido, registre como lista de espera para uma próxima abertura.`,
      link,
    ].filter(Boolean);
    await sendToAll(lines.join('\n'), { skipDelay: true });
    return;
  }

  const lines = [
    `🤍 *Lead - Lista VIP Evelyn Liu*`,
    ``,
    `👤 *${nome}*`,
    `💬 Resposta: "${String(text || '').slice(0, 280)}"`,
    ``,
    `• Lead respondeu positivamente à campanha sazonal.`,
    `• Lead respondeu a uma campanha antiga. Não ofereça consulta avulsa.`,
    `• Se houver intenção explícita de acompanhamento direto com a Evelyn, conduza pela modalidade atual de 3 meses.`,
    `• Abertura pontual (sem trava automática de vagas) — negocie normalmente mesmo além das 3 primeiras respostas.`,
    ``,
    `*Próxima ação:* entrar em contato pelo WhatsApp para apresentar os horários e conduzir o agendamento.`,
    link,
  ].filter(Boolean);

  await sendToAll(lines.join('\n'), { skipDelay: true });
}

// Aviso leve: o participante respondeu algo que não foi classificado como
// interesse positivo. Não move o card; só garante que nada se perca.
export async function notifyKarinaCampanhaResposta(participant, text, { positive } = {}) {
  const nome = participant?.nome || 'Lead';
  const phone = campanhaCleanPhone(participant);
  const link = phone ? `🔗 https://wa.me/${phone}` : '';
  const lines = [
    `📩 *Lista VIP Evelyn Liu — resposta recebida*`,
    ``,
    `👤 *${nome}*`,
    `💬 "${String(text || '').slice(0, 280)}"`,
    ``,
    `Sem sinal claro de interesse — avalie se vale responder manualmente.`,
    link,
  ].filter(Boolean);
  await sendToAll(lines.join('\n'), { skipDelay: true });
}

export async function notifyError(phone, errorMessage) {
  const lines = [
    `⚠️ *ERRO AO RESPONDER LEAD*`,
    ``,
    `📱 Número: ${phone}`,
    `❌ Erro: ${errorMessage}`,
    ``,
    `Verifique a conversa e responda manualmente se necessário.`,
    `🔗 https://wa.me/${phone}`,
  ];

  await sendToAll(lines.join('\n'), { skipDelay: true });
}
