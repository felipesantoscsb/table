// src/webhook/zapiHandler.js

import { isActiveLead, isHandedOff, setHandedOff, blockPhone, unblockPhone, isBlocked, addMessage, getHistory, getLeadData, getSdrHistory, addSdrMessage, incrementTurn, getTurnCount, TURN_LIMIT, enqueueMessage, dequeueMessages, normalizePhone, deactivateLead, getConversationMode } from '../conversation/store.js';
import { aggregate } from '../conversation/aggregator.js';
import { generateReply, generateHandoffBriefing, generateConsultivo, generateFirstContact } from '../ai/anthropic.js';
import { sendMessage, notifySDR, notifySDRHandoff, notifySDRRedflag, notifySDRTurnLimit, notifyError } from '../zapi/sender.js';
import { handlePlanoCommand } from '../planos/handler.js';
import { getQuizPreData } from './quizPreHandler.js';
import { activateLead } from '../conversation/store.js';
import { garantirLeadCaptacaoNoHub, migrarParaPreConsulta, verificarElegibilidadeContatoSdr, bloqueioDefinitivoSdr } from '../hub/client.js';
import { getParticipant, handleCampanhaReply } from '../campanha/handler.js';
import { config } from '../../config/index.js';

// Frase que ativa leads pós-quiz via WhatsApp direto
const FRASE_QUIZ = 'oi! fiz o quiz da table clinic e quero saber mais sobre os programas de acompanhamento';

function dentroDoHorario() {
  const agora = new Date();
  const brasilia = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const diaSemana = brasilia.getDay();
  const hora = brasilia.getHours();
  const fimDeSemana = diaSemana === 0 || diaSemana === 6;
  if (fimDeSemana) return hora >= 8 && hora < 17;
  return hora >= 8 && hora < 21;
}

export async function handleZapiMessage(req, res) {
  res.status(200).json({ ok: true });

  try {
    const body = req.body;
    if (body.type !== 'ReceivedCallback') return;

    const phone = normalizePhone(body.phone || '');
    const messageText = body.text?.message || body.text;

    if (!phone || !messageText) return;
    if (body.isFromMe) return;

    // Mensagem da Karina
    if (phone === normalizePhone(config.sdr.phone)) {
      const trimmed = messageText.trim();
      if (trimmed.toLowerCase().startsWith('/unstop')) {
        const targetPhone = normalizePhone(trimmed.slice(7).trim());
        if (!targetPhone) {
          await avisaKarina('Uso: /unstop 5511999999999');
          return;
        }
        await unblockPhone(targetPhone);
        await avisaKarina(`🔓 Lead ${targetPhone} desbloqueada — a automação pode voltar a contatá-la.`);
        return;
      }
      if (trimmed.toLowerCase().startsWith('/stop')) {
        const targetPhone = normalizePhone(trimmed.slice(5).trim());
        if (!targetPhone) {
          await avisaKarina('Uso: /stop 5511999999999');
          return;
        }
        // Bloquear o próprio número da SDR silenciaria todas as notificações.
        if (targetPhone === normalizePhone(config.sdr.phone)) {
          await avisaKarina('⚠️ Não dá para bloquear o próprio número da SDR — isso silenciaria todas as notificações.');
          return;
        }
        // handedOff silencia a conversa atual; blockPhone impede que qualquer
        // novo gatilho (quiz, formulário, recuperação de checkout, disparo)
        // reative o número mais tarde.
        await setHandedOff(targetPhone);
        await blockPhone(targetPhone);
        await avisaKarina(`✅ Lead ${targetPhone} desativada e bloqueada. Use /unstop ${targetPhone} para reverter.`);
        return;
      }
      if (trimmed.toLowerCase().startsWith('/plano')) {
        await handlePlanoCommand(trimmed.slice(6).trim());
        return;
      }
      await handleSdrConsultivo(trimmed);
      return;
    }

    // Bloqueio permanente tem prioridade sobre tudo: nem campanha, nem frase do
    // quiz, nem lead ativa fazem o agente responder um número bloqueado.
    if (await isBlocked(phone)) {
      console.log(`⛔ Mensagem ignorada de ${phone} (número bloqueado)`);
      return;
    }

    // Resposta a campanha sazonal (ex.: Lista VIP Evelyn Liu) tem prioridade:
    // interrompe qualquer automação para este número e nunca cai no fluxo do
    // agente SDR nem na ativação por frase de quiz.
    const campanhaParticipant = await getParticipant(phone);
    if (campanhaParticipant) {
      console.log(`🤍 Resposta de participante de campanha: ${phone}`);
      await handleCampanhaReply(phone, messageText, campanhaParticipant);
      return;
    }

    // Verifica frase de ativação pós-quiz
    if (messageText.trim().toLowerCase() === FRASE_QUIZ) {
      console.log(`🎯 Frase quiz detectada de ${phone}`);
      await handleQuizActivation(phone);
      return;
    }

    if (!await isActiveLead(phone)) {
      console.log(`⏭️  Mensagem ignorada de ${phone} (não é lead ativo)`);
      return;
    }

    if (await isHandedOff(phone)) {
      console.log(`⏭️  Mensagem ignorada de ${phone} (handoff ativo)`);
      return;
    }

    if (!dentroDoHorario()) {
      console.log(`⏰ Fora do horário — enfileirando mensagem de ${phone}`);
      await enqueueMessage(phone, messageText);
      return;
    }

    console.log(`📨 Mensagem de lead ativo ${phone}`);
    aggregate(phone, messageText, processAggregatedMessages);

  } catch (err) {
    console.error('❌ Erro no handler da Zapi:', err.message);
  }
}

function avisaKarina(texto) {
  return sendMessage(config.sdr.phone, texto, { skipDelay: true });
}

async function handleQuizActivation(phone) {
  try {
    // Busca dados do quiz armazenados no Redis
    const quizData = await getQuizPreData(phone);

    let leadData;

    if (quizData) {
      console.log(`📦 Dados do quiz encontrados para ${phone}`);
      leadData = {
        ...quizData,
        source: 'quiz_botao_whatsapp',
      };
    } else {
      // Sem dados do quiz — ativa com perfil mínimo e conduz investigação
      console.log(`⚠️  Sem dados do quiz para ${phone} — ativando com perfil mínimo`);
      leadData = {
        nome: 'você',
        whatsapp: phone,
        whats: phone,
        source: 'quiz_botao_whatsapp',
        temperatura: 'warm',
        score: 5,
        qualificacao: { tier: 'warm', score: 5 },
        historico: [],
        respostas: [],
      };
    }

    // Só o veto definitivo do Hub (paciente/convertido) impede a ativação;
    // check indisponível ou lead sem card não bloqueia (fail-open).
    const eligibility = await verificarElegibilidadeContatoSdr({ phone, leadData, source: 'quiz_botao_whatsapp', purpose: 'activation' });
    if (bloqueioDefinitivoSdr(eligibility)) {
      console.warn(`🛑 Ativação pós-quiz bloqueada para ${phone}: ${eligibility.reason}`);
      await deactivateLead(phone);
      return;
    }

    // Card no CRM é bookkeeping: não condiciona a ativação.
    garantirLeadCaptacaoNoHub({
      leadData: { ...leadData, source: leadData.source || 'captacao_sdr' },
      phone,
    }).catch(err => {
      console.warn(`⚠️ Card de captação não criado no Hub para ${phone}: ${err.message}`);
    });

    const result = await generateFirstContact(leadData);

    leadData._monitorarDePerto = result.orientacao?.monitorarDePerto || false;
    leadData._avisoNatalia = result.avisoNatalia || false;

    await activateLead(phone, leadData);
    await addMessage(phone, 'assistant', result.leadMessage);

    if (!dentroDoHorario()) {
      await enqueueMessage(phone, `__PRIMEIRA_MENSAGEM__${result.leadMessage}`);
      await notifySDR(leadData, result.sdrBriefing);
      return;
    }

    await sendMessage(phone, result.leadMessage);
    await notifySDR(leadData, result.sdrBriefing);

    console.log(`✅ Lead pós-quiz ativada: ${phone}`);
  } catch (err) {
    console.error(`❌ Erro ao ativar lead pós-quiz ${phone}:`, err.message);
  }
}

export async function processQueue(phone) {
  const messages = await dequeueMessages(phone);
  if (!messages.length) return;

  console.log(`📬 Processando fila de ${phone}: ${messages.length} mensagens`);

  const primeiraMsg = messages.find(m => m.startsWith('__PRIMEIRA_MENSAGEM__'));
  const respostas = messages.filter(m => !m.startsWith('__PRIMEIRA_MENSAGEM__'));

  if (primeiraMsg) {
    const texto = primeiraMsg.replace('__PRIMEIRA_MENSAGEM__', '');
    await sendMessage(phone, texto);
  }

  if (respostas.length) {
    const combined = respostas.join('\n');
    await processAggregatedMessages(phone, combined);
  }
}

async function handleSdrConsultivo(pergunta) {
  try {
    const historico = getSdrHistory();
    addSdrMessage('user', pergunta);
    const resposta = await generateConsultivo(pergunta, historico);
    addSdrMessage('assistant', resposta);
    await sendMessage(config.sdr.phone, resposta, { skipDelay: true });
  } catch (err) {
    console.error('❌ Erro no modo consultivo:', err.message);
  }
}

async function processAggregatedMessages(phone, combinedMessage) {
  console.log(`⚡ Processando mensagens de ${phone}`);

  try {
    const history = await getHistory(phone);
    const leadData = await getLeadData(phone);
    // Bloqueia a resposta automática apenas com veto definitivo do Hub
    // (paciente ou venda concluída); indisponibilidade não silencia o agente.
    const eligibility = await verificarElegibilidadeContatoSdr({ phone, leadData, source: 'sdr_reply' });
    if (bloqueioDefinitivoSdr(eligibility)) {
      console.warn(`🛑 Resposta automática bloqueada para ${phone}: ${eligibility.reason}`);
      await deactivateLead(phone);
      if (eligibility.patient) {
        await sendMessage(
          config.sdr.phone,
          `⚠️ Automação SDR bloqueada para paciente: ${eligibility.patient.name || phone} (${phone}).`,
          { skipDelay: true }
        );
      }
      return;
    }
    if (!eligibility.allowed) {
      console.warn(`⚠️ Elegibilidade inconclusiva para ${phone} — respondendo mesmo assim: ${eligibility.reason}`);
    }

    await addMessage(phone, 'user', combinedMessage);
    await incrementTurn(phone);

    const turns = await getTurnCount(phone);
    console.log(`🔢 Turno ${turns}/${TURN_LIMIT} para ${phone}`);

    if (turns >= TURN_LIMIT) {
      console.log(`🛑 Teto de turnos atingido para ${phone}`);
      await setHandedOff(phone);
      const briefing = await generateHandoffBriefing(leadData, await getHistory(phone), 'não informado');
      await notifySDRTurnLimit(leadData, briefing);
      return;
    }

    const mode = await getConversationMode(phone);
    const result = await generateReply(phone, combinedMessage, history, leadData, mode);

    if (result.redflag) {
      console.log(`🚨 Red flag detectado para ${phone}`);
      await setHandedOff(phone);
      await notifySDRRedflag(leadData, result.redflagMotivo);
      return;
    }

    if (result.handoff) {
      console.log(`🟢 Handoff ativado para ${phone}`);
      await addMessage(phone, 'assistant', result.leadMessage);
      await sendMessage(phone, result.leadMessage);
      await setHandedOff(phone);
      const handoffBriefing = await generateHandoffBriefing(leadData, await getHistory(phone), result.handoffTurno);
      await notifySDRHandoff(leadData, result.handoffTurno, handoffBriefing);
      // Migra o card de captação para pré-consulta / "A Agendar" no Hub (igual ao Protocolo Raiz).
      // Fire-and-forget: nunca deve bloquear nem quebrar o handoff para a Karina.
      migrarParaPreConsulta({ leadData, phone, turno: result.handoffTurno, briefing: handoffBriefing })
        .catch(err => console.error('[hub] erro ao migrar card no handoff:', err.message));
      return;
    }

    await addMessage(phone, 'assistant', result.leadMessage);
    await sendMessage(phone, result.leadMessage);

  } catch (err) {
    console.error(`❌ Erro ao processar resposta para ${phone}:`, err.message);
    await notifyError(phone, err.message);
  }
}
