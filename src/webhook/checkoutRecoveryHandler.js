// src/webhook/checkoutRecoveryHandler.js
//
// Recebe do aquisicao-table os gatilhos de recuperação de checkout (abandono e
// pix gerado não pago) e envia a mensagem humanizada da Karina via Z-API. A
// conversa fica registrada para que o agente conduza eventuais respostas.
// Autenticado por RECOVERY_TOKEN (header x-recovery-token).

import { generateRecoveryMessage } from '../ai/anthropic.js';
import { sendMessage } from '../zapi/sender.js';
import { addMessage, getLeadData, setRecoveryMode, isBlocked } from '../conversation/store.js';

export async function handleCheckoutRecovery(req, res) {
  const token = req.headers['x-recovery-token'];
  if (!process.env.RECOVERY_TOKEN || token !== process.env.RECOVERY_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const p = req.body || {};
  if (!p.phone) return res.status(400).json({ error: 'phone obrigatório' });

  res.json({ ok: true, queued: true }); // responde já; envia depois

  try {
    // Opt-out permanente (/stop) antes de qualquer coisa: o aquisicao-table pode
    // seguir disparando o gatilho, mas nada sai daqui — nem a chamada de LLM.
    if (await isBlocked(p.phone)) {
      console.log(`[Recovery-SDR] ignorado para ${p.phone} — número bloqueado`);
      return;
    }

    // Enriquece o perfil emocional pela conversa, se a lead já existir aqui.
    let perfil = p.perfil || null;
    try {
      const lead = await getLeadData(p.phone);
      perfil = perfil || lead?.qualificacao?.perfil || lead?.perfil || null;
    } catch {}

    const message = await generateRecoveryMessage({ ...p, perfil });
    if (!message) {
      console.error('[Recovery-SDR] mensagem vazia — nada enviado.');
      return;
    }

    // Ativa a conversa em modo recovery ANTES de registrar a mensagem, para que
    // eventuais respostas da lead sejam conduzidas pelo prompt de recuperação
    // (nunca cai no sdr.txt, que tentaria agendar pré-consulta).
    await setRecoveryMode(p.phone, {
      nome: p.name || null,
      whats: p.phone,
      source: 'checkout_recovery',
      recovery: { pix_code: p.pix_code || null, checkout_url: p.checkout_url || null, stage: p.stage || null },
    }).catch(() => {});

    // sendMessage já anexa ?sck aos links Cakto (atribuição) e aplica delay humano.
    await sendMessage(p.phone, message);
    await addMessage(p.phone, 'assistant', message).catch(() => {});
    console.log(`[Recovery-SDR] enviada (${p.stage} toque ${p.touch || 1}) para ${p.phone}`);
  } catch (e) {
    console.error('[Recovery-SDR] erro:', e.message);
  }
}
