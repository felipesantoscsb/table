// src/hub/client.js
// Cliente do Hub CRM (hub-tableclinic). No handoff do agente SDR para agendar
// pré-consulta, migra o card da lead do funil 'captacao' para 'pre_consulta'
// na etapa "A Agendar" — mesmo processo do Protocolo Raiz.

import axios from 'axios';

const HUB_URL = process.env.HUB_HANDOFF_URL
  || 'https://crm.tableclinic.com.br/webhook/handoff-agendamento';
const HUB_TEMPLATE_SENT_URL = process.env.HUB_TEMPLATE_SENT_URL
  || 'https://crm.tableclinic.com.br/webhook/whatsapp-template-sent';
const HUB_CONTACT_CHECK_URL = process.env.HUB_CONTACT_CHECK_URL
  || 'https://crm.tableclinic.com.br/webhook/sdr-contact-check';
const HUB_CAPTACAO_LEAD_URL = process.env.HUB_CAPTACAO_LEAD_URL
  || 'https://crm.tableclinic.com.br/webhook/quiz';
const HUB_SECRET = process.env.HUB_WEBHOOK_SECRET || process.env.INTERNAL_WEBHOOK_SECRET;
const HUB_EVELYN_EVENT_URL = process.env.HUB_EVELYN_EVENT_URL
  || 'https://crm.tableclinic.com.br/webhook/evelyn-branch/event';

const retryDelays = [0, 1500, 4000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Migra o card da lead para pré-consulta / "A Agendar" no Hub, com todos os
// dados do atendimento nas observações. Fire-and-forget no chamador: nunca
// deve quebrar o handoff para a Karina.
export async function migrarParaPreConsulta({ leadData = {}, phone, turno, briefing }) {
  if (!HUB_SECRET) {
    console.warn('[hub] HUB_WEBHOOK_SECRET não configurado — migração de card ignorada');
    return null;
  }

  const payload = {
    nome:             leadData.nome || leadData.name || 'Lead',
    telefone:         phone,
    temperatura:      leadData.temperatura,
    score:            leadData.score,
    oqueMaisPesa:     leadData.oqueMaisPesa,
    dores:            leadData.dores,
    maiorDificuldade: leadData.maiorDificuldade,
    dificuldade:      leadData.dificuldade,
    historico:        leadData.historico,
    saude:            leadData.saude,
    comprometimento:  leadData.comprometimento,
    source:           leadData.source || 'captacao_sdr',
    turno:            turno || null,
    briefing:         briefing || null,
    created_at:       new Date().toISOString(),
  };

  let lastError;
  for (let attempt = 0; attempt < retryDelays.length; attempt++) {
    if (retryDelays[attempt]) await sleep(retryDelays[attempt]);
    try {
      const res = await axios.post(HUB_URL, payload, {
        headers: { 'Content-Type': 'application/json', 'x-webhook-secret': HUB_SECRET },
        timeout: 12_000,
      });
      console.log(`[hub] card migrado p/ pré-consulta — ${payload.nome} (${phone}) card ${res.data?.card_id}`);
      return res.data;
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      console.warn(`[hub] tentativa ${attempt + 1} falhou${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    }
  }
  throw lastError;
}

export async function registrarEventoEvelyn({eventId,eventType,phone,leadData={},payload={}}){
  if(!HUB_SECRET)return null;
  try{
    const res=await axios.post(HUB_EVELYN_EVENT_URL,{event_id:eventId,event_type:eventType,phone,lead_name:leadData.nome||leadData.name||null,source:leadData.source||null,occurred_at:new Date().toISOString(),payload},{headers:{'Content-Type':'application/json','x-webhook-secret':HUB_SECRET},timeout:8000});
    return res.data;
  }catch(err){console.warn(`[evelyn] analytics não bloqueante: ${err.message}`);return null;}
}

export async function registrarTemplateWhatsApp({ leadData = {}, phone, templateName, params = [], provider = null }) {
  if (!HUB_SECRET) {
    console.warn('[hub] HUB_WEBHOOK_SECRET não configurado — registro de template ignorado');
    return null;
  }

  const payload = {
    phone,
    nome: leadData.nome || leadData.name || 'Lead',
    template_name: templateName,
    params,
    provider,
    provider_message_id: provider?.messages?.[0]?.id || null,
    source: leadData.source || null,
    tier: leadData.tier || leadData.temperatura || leadData.qualificacao?.tier || null,
    funnel: String(leadData.source || '').toLowerCase().includes('quiz') ? 'quiz' : 'captacao',
  };

  try {
    const res = await axios.post(HUB_TEMPLATE_SENT_URL, payload, {
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': HUB_SECRET },
      timeout: 12_000,
    });
    console.log(`[hub] template ${templateName} registrado no Hub — conversa ${res.data?.conversation_id}`);
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    console.warn(`[hub] falha ao registrar template ${templateName}${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    return null;
  }
}

export async function garantirLeadCaptacaoNoHub({ leadData = {}, phone }) {
  const payload = {
    nome: leadData.nome || leadData.name || 'Lead',
    whats: phone,
    phone,
    email: leadData.email || null,
    origin: leadData.origin || 'Formulário',
    source: leadData.source || 'captacao_sdr',
    tier: leadData.tier || leadData.temperatura || leadData.qualificacao?.tier || null,
    score: leadData.score || leadData.qualificacao?.score || null,
    obs_form: [
      leadData.oqueMaisPesa || leadData.dores ? `O que mais pesa: ${leadData.oqueMaisPesa || leadData.dores}` : null,
      leadData.saude ? `Saúde: ${leadData.saude}` : null,
      leadData.comprometimento ? `Comprometimento: ${leadData.comprometimento}` : null,
      leadData.maiorDificuldade || leadData.dificuldade ? `Maior dificuldade: ${leadData.maiorDificuldade || leadData.dificuldade}` : null,
      leadData.historico ? `Histórico: ${Array.isArray(leadData.historico) ? leadData.historico.join('\n') : leadData.historico}` : null,
    ].filter(Boolean).join('\n') || null,
  };

  try {
    const res = await axios.post(HUB_CAPTACAO_LEAD_URL, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 12_000,
    });
    console.log(`[hub] lead de captação garantida no Hub — ${payload.nome} (${phone}) funil ${res.data?.funnel}`);
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    console.warn(`[hub] falha ao garantir lead de captação${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    throw err;
  }
}

// Só estas razões representam veto definitivo do Hub: a pessoa é paciente ou
// já comprou. Qualquer outra resposta (check indisponível, secret ausente,
// lead sem card no CRM etc.) NÃO bloqueia o agente — fail-open, para a
// captação nunca parar por indisponibilidade ou lacuna de dados do Hub.
const RAZOES_BLOQUEIO_DEFINITIVO = new Set(['patient', 'converted_or_won']);

export function bloqueioDefinitivoSdr(eligibility) {
  return !eligibility?.allowed && RAZOES_BLOQUEIO_DEFINITIVO.has(eligibility?.reason);
}

export async function verificarElegibilidadeContatoSdr({ phone, leadData = {}, source = 'sdr_auto', purpose = null }) {
  if (!HUB_SECRET) {
    console.warn('[hub] HUB_WEBHOOK_SECRET não configurado — contato bloqueado por segurança');
    return { allowed: false, reason: 'hub_secret_missing' };
  }

  try {
    const res = await axios.post(HUB_CONTACT_CHECK_URL, {
      phone,
      nome: leadData.nome || leadData.name || null,
      source: leadData.source || source,
      purpose,
    }, {
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': HUB_SECRET },
      timeout: 8_000,
    });
    return {
      allowed: res.data?.allowed === true,
      reason: res.data?.reason || null,
      patient: res.data?.patient || null,
      card: res.data?.card || null,
    };
  } catch (err) {
    const status = err.response?.status;
    console.warn(`[hub] falha ao verificar elegibilidade SDR${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    return { allowed: false, reason: 'hub_check_failed' };
  }
}
