// src/webhook/makeHandler.js
// Processa leads do formulário Make → ativa o agente SDR.

import { activateLead, addMessage, enqueueMessage, normalizePhone, setHandedOff, isBlocked } from '../conversation/store.js';
import { generateFirstContact } from '../ai/anthropic.js';
import { sendMessage, notifyManualHandoffBatch, notifySDR } from '../zapi/sender.js';
import { garantirLeadCaptacaoNoHub, verificarElegibilidadeContatoSdr, bloqueioDefinitivoSdr } from '../hub/client.js';

function dentroDoHorario() {
  const agora = new Date();
  const brasilia = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const diaSemana = brasilia.getDay();
  const hora = brasilia.getHours();
  const fimDeSemana = diaSemana === 0 || diaSemana === 6;
  if (fimDeSemana) return hora >= 8 && hora < 17;
  return hora >= 8 && hora < 21;
}

function normalizeLead(body) {
  return {
    nome:             body['Nome']              || body['nome']             || 'Lead',
    whatsapp:         body['WhatsApp']          || body['whatsapp']         || body['Whatsapp'] || body['whats'] || '',
    whats:            body['WhatsApp']          || body['whatsapp']         || body['Whatsapp'] || body['whats'] || '',
    temperatura:      body['Temperatura']       || body['temperatura']      || body['qualificacao']?.tier || 'desconhecida',
    score:            body['Score']             || body['score']            || body['qualificacao']?.score || '0',
    qualificacao:     body['qualificacao']      || null,
    oqueMaisPesa:     body['O que mais pesa']   || body['oqueMaisPesa']     || body['dores'] || '',
    dores:            body['dores']             || body['O que mais pesa']  || '',
    historico:        body['Histórico']         || body['historico']        || body['Historico'] || '',
    saude:            body['Saúde']             || body['saude']            || body['Saude'] || '',
    comprometimento:  body['Comprometimento']   || body['comprometimento']  || '',
    maiorDificuldade: body['Maior dificuldade'] || body['maiorDificuldade'] || body['dificuldade'] || '',
    dificuldade:      body['dificuldade']       || body['Maior dificuldade']|| '',
    source:           body['source']            || body['Source']           || '',
  };
}

function isNataliaSource(leadData = {}) {
  const fields = [
    leadData.source,
    leadData.origin,
    leadData.event_source_url,
    leadData.url,
    leadData.slug,
    leadData.utm?.source,
    leadData.utm?.campaign,
  ].filter(Boolean).map(v => String(v).toLowerCase());

  return fields.some(v => v.includes('natalia') || v.includes('natália') || v.includes('kelm'));
}

async function validateAndActivateLead(leadData, phone) {
  // Opt-out permanente (/stop) vem antes de qualquer check: nem chama o Hub.
  if (await isBlocked(phone)) {
    console.warn(`⛔ Lead ${leadData.nome} (${phone}) ignorado — número bloqueado`);
    return { ok: false, blocked: true, reason: 'phone_blocked' };
  }

  // Único veto que impede a ativação: o Hub confirmar que é paciente ou venda
  // concluída. Check indisponível/inconclusivo não bloqueia (fail-open).
  const eligibility = await verificarElegibilidadeContatoSdr({
    phone,
    leadData,
    source: 'captacao_formulario',
    purpose: 'activation',
  });
  if (bloqueioDefinitivoSdr(eligibility)) {
    console.warn(`🛑 Lead ${leadData.nome} (${phone}) bloqueado pelo Hub: ${eligibility.reason}`);
    return { ok: false, blocked: true, reason: eligibility.reason };
  }
  if (!eligibility.allowed) {
    console.warn(`⚠️ Elegibilidade inconclusiva para ${leadData.nome} (${phone}) — ativando mesmo assim: ${eligibility.reason}`);
  }

  try {
    await activateLead(phone, leadData);
  } catch (e) {
    console.error(`⚠️ Falha ao persistir lead ${leadData.nome} no Redis:`, e.message);
    return { ok: false, reason: 'redis_activation_failed' };
  }

  return { ok: true };
}

async function finishLeadFirstContact(leadData, phone) {
  try {
    const result = await generateFirstContact(leadData);

    leadData._monitorarDePerto = result.orientacao?.monitorarDePerto || false;
    leadData._avisoNatalia = result.avisoNatalia || false;

    // Reatualiza com os campos derivados da IA (idempotente)
    await activateLead(phone, leadData);
    await addMessage(phone, 'assistant', result.leadMessage);

    if (!dentroDoHorario()) {
      console.log(`⏰ Lead ${leadData.nome} fora do horário — mensagem enfileirada`);
      await enqueueMessage(phone, `__PRIMEIRA_MENSAGEM__${result.leadMessage}`);
      await notifySDR(leadData, result.sdrBriefing);
      return;
    }

    await sendMessage(phone, result.leadMessage);
    await notifySDR(leadData, result.sdrBriefing);

    console.log(`✅ Lead ${leadData.nome} processado`);
  } catch (err) {
    console.error(`❌ Erro ao processar lead ${leadData.nome}:`, err.message);
  }
}

async function handoffNataliaLead(leadData, phone) {
  await activateLead(phone, { ...leadData, _avisoNatalia: true });
  await setHandedOff(phone);
  await addMessage(phone, 'assistant', '[handoff manual: lead Natália Kelm]');
  await notifyManualHandoffBatch({
    title: '⚠️ *Lead Natália para ativação manual*',
    leads: [{
      ...leadData,
      phone,
      status: 'lead deve ser acionada manualmente pela Karina',
      lastUser: '',
    }],
  });
}

function authWebhook(req, res) {
  const secret = req.headers['x-webhook-secret'] || req.body.secret;
  if (secret !== process.env.WEBHOOK_SECRET) {
    console.warn('Tentativa de acesso com segredo inválido');
    res.status(401).json({ error: 'Não autorizado' });
    return false;
  }
  return true;
}

export async function handleMakeLead(req, res) {
  if (!authWebhook(req, res)) return;

  const leadData = normalizeLead(req.body);
  const phone = normalizePhone(leadData.whatsapp || leadData.whats);

  if (!phone) {
    return res.status(400).json({ error: 'Campo WhatsApp é obrigatório' });
  }

  console.log(`📥 Novo lead recebido: ${leadData.nome} (${phone})`);

  const activation = await validateAndActivateLead(leadData, phone);
  if (!activation.ok) {
    // Bloqueio definitivo (paciente/convertido) responde 200 para o formulário
    // não reprocessar; falha transitória (Redis) responde 500 para o
    // aquisicao-table guardar e reenviar via drain.
    if (activation.blocked) {
      return res.status(200).json({ received: true, activated: false, phone, reason: activation.reason });
    }
    return res.status(500).json({ received: true, activated: false, phone, reason: activation.reason });
  }

  if (isNataliaSource(leadData)) {
    try {
      await handoffNataliaLead(leadData, phone);
      return res.status(200).json({ received: true, activated: false, manual_handoff: true, phone });
    } catch (err) {
      console.error(`❌ Erro ao gerar handoff manual Natália ${leadData.nome}:`, err.message);
      return res.status(500).json({ received: true, activated: false, phone, reason: 'manual_handoff_failed' });
    }
  }

  res.status(200).json({ received: true, activated: true, phone });

  // Card no CRM é bookkeeping: nunca condiciona a ativação nem o 1º contato.
  garantirLeadCaptacaoNoHub({ leadData, phone }).catch(err => {
    console.warn(`⚠️ Card de captação não criado no Hub para ${leadData.nome} (${phone}): ${err.message}`);
  });

  finishLeadFirstContact(leadData, phone).catch(err => {
    console.error(`❌ Erro ao finalizar primeiro contato ${leadData.nome}:`, err.message);
  });
}
