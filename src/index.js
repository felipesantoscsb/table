// src/index.js

import express from 'express';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';
import { handleMakeLead } from './webhook/makeHandler.js';
import { handleQuizLead } from './webhook/quizHandler.js';
import { handleZapiMessage, processQueue } from './webhook/zapiHandler.js';
import { handleQuizPre } from './webhook/quizPreHandler.js';
import { handleDisparo, fireDossie, DOSSIE_WHATSAPP_ENABLED } from './disparos/handler.js';
import { gerarDossie } from './disparos/gerador.js';
import { handleTrack } from './webhook/trackHandler.js';
import { handleTicto } from './webhook/tictoHandler.js';
import { handleCheckoutRecovery } from './webhook/checkoutRecoveryHandler.js';
import { handleCampanhaRegistro } from './campanha/handler.js';
import { getPhonesWithQueue } from './conversation/store.js';
import {
  startFollowUpJob,
  fireFollowUp,
  dentroDoHorario,
  clearPendingFollowUps,
  FOLLOWUP_6H_ENABLED,
} from './followup.js';
import {
  startQuizCadenceJob,
  handleQuizCadenceCancel,
  checkQuizCadence,
  clearPendingQuizCadence,
  QUIZ_CADENCE_ENABLED,
} from './quizCadence.js';
import { safeKeys, safeGet, safeSet, safeDel } from './redis.js';
const redisGet = safeGet; // alias para clareza no recovery

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());

// Fotos da equipe
app.use('/fotos', express.static(join(__dirname, '../public/fotos')));

// Propostas e dossiês servidos na raiz (mesmo domínio jornada.tableclinic.com.br)
app.use('/', express.static(join(__dirname, '../public/planos')));

// Webhooks
app.post('/webhook/lead', handleMakeLead);
app.post('/webhook/quiz', handleQuizLead);
app.post('/webhook/zapi', handleZapiMessage);
app.post('/webhook/quiz-pre', handleQuizPre);
app.post('/webhook/disparo', handleDisparo);
app.post('/webhook/ticto', handleTicto);
app.post('/webhook/checkout-recovery', handleCheckoutRecovery);
app.post('/webhook/campanha-registro', handleCampanhaRegistro);
app.post('/webhook/quiz-cadence/cancel', handleQuizCadenceCancel);

// Track link (follow-up)
app.get('/track/:uuid', handleTrack);

// Dossiês personalizados — servidos via raiz.evelynliu.com.br/d/:slug
const DOSSIE_PERFIL_MAP = {
  E: 'emocional', R: 'restritiva', S: 'sobrevivencia', A: 'desconectada',
  emocional: 'emocional', restritiva: 'restritiva',
  sobrevivencia: 'sobrevivencia', desconectada: 'desconectada',
};
const DOSSIE_STATIC_SLUGS = {
  emocional: 'E',
  restritiva: 'R',
  sobrevivencia: 'S',
  desconectada: 'A',
};
app.get('/d/:slug', async (req, res) => {
  const { slug } = req.params;

  if (DOSSIE_STATIC_SLUGS[slug]) {
    const html = gerarDossie(DOSSIE_STATIC_SLUGS[slug], '', null, '', []);
    console.log(`[/d/:slug] ${slug} → dossiê padrão`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  }

  // 1ª fonte: HTML completo no Redis (sobrevive a redeploys)
  let html = await safeGet(`dossie_html:${slug}`);
  if (html) {
    console.log(`[/d/:slug] ${slug} → servido do Redis`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  }

  // metadados da lead (phone, perfil, nome)
  const raw = await safeGet(`dossie:${slug}`);
  if (!raw) return res.status(404).send('Dossiê não encontrado ou expirado');
  let meta;
  try { meta = JSON.parse(raw); } catch { return res.status(500).send('Erro interno'); }

  // 2ª fonte: arquivo gerado em disco (legado, pode ter sumido no redeploy)
  try {
    html = readFileSync(join(__dirname, '../public/planos', `${slug}.html`), 'utf-8');
    console.log(`[/d/:slug] ${slug} → servido do disco (legado)`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch { /* segue para fallback */ }

  // 3ª fonte (fallback): regenera o template do perfil com o nome da lead
  const perfilLetra = { emocional: 'E', restritiva: 'R', sobrevivencia: 'S', desconectada: 'A' }[
    DOSSIE_PERFIL_MAP[meta.perfil] || 'emocional'
  ];
  try {
    html = gerarDossie(perfilLetra, meta.nome || 'você', null, '', []);
    await safeSet(`dossie_html:${slug}`, html, 'EX', 7 * 24 * 60 * 60); // recacheia
    console.log(`[/d/:slug] ${slug} → regenerado via fallback (${meta.perfil})`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch {
    return res.status(404).send('Dossiê não encontrado ou expirado');
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()) + 's' });
});

// ─── Recovery de timers após redeploy ────────────────────────────────────────

async function recoverPendingTimers() {
  const now = Date.now();
  let dossiesRecovered = 0;
  let followupsRecovered = 0;

  // ── Dossiês pendentes ──────────────────────────────────────────────────────
  const dossieKeys = await safeKeys('pending_dossie:*');
  for (const key of dossieKeys) {
    if (!DOSSIE_WHATSAPP_ENABLED) {
      await safeDel(key);
      continue;
    }

    const raw = await safeGet(key);
    if (!raw) continue;
    let pending;
    try { pending = JSON.parse(raw); } catch { continue; }

    const { phone, leadData, fire_at } = pending;
    if (!phone || !leadData) continue;

    const remaining = fire_at - now;
    const delay = remaining > 0 ? remaining : 0;

    if (remaining <= 0) {
      console.log(`⚡ [recovery] Dossiê para ${leadData.nome} (${phone}) — atrasado ${Math.round(-remaining / 60000)}min, disparando agora`);
    } else {
      console.log(`⏳ [recovery] Dossiê para ${leadData.nome} (${phone}) — reagendado em ${Math.round(delay / 60000)}min`);
    }

    setTimeout(() => fireDossie(leadData), delay);
    dossiesRecovered++;
  }

  // ── Follow-ups pendentes ───────────────────────────────────────────────────
  if (FOLLOWUP_6H_ENABLED) {
    const followupKeys = await safeKeys('pending_followup:*');
    for (const key of followupKeys) {
      const raw = await safeGet(key);
      if (!raw) continue;
      let pending;
      try { pending = JSON.parse(raw); } catch { continue; }

      const { phone, leadData, fire_at } = pending;
      if (!phone || !leadData) continue;

      // Se já enviou o follow-up, ignora
      const jaEnviou = await redisGet(`followup:${phone}`);
      if (jaEnviou) continue;

      // Se já comprou, ignora
      const comprou = await redisGet(`compra:${phone}`);
      if (comprou) continue;

      const remaining = fire_at - now;

      // Dispara só dentro do horário comercial. Se fora (ou atrasado de
      // madrugada), o cron checkFollowUps reprocessa quiz:* no próximo
      // horário válido — evita follow-up de madrugada.
      const fire = () => { if (dentroDoHorario()) fireFollowUp(leadData, phone); };

      if (remaining <= 0) {
        console.log(`⚡ [recovery] Follow-up para ${leadData.nome} (${phone}) — atrasado; cron reprocessa no horário válido`);
        setTimeout(fire, 0);
      } else {
        console.log(`⏳ [recovery] Follow-up para ${leadData.nome} (${phone}) — reagendado em ${Math.round(remaining / 60000)}min`);
        setTimeout(fire, remaining);
      }
      followupsRecovered++;
    }
  }

  // ── Cadência oficial pós-quiz pendente ─────────────────────────────────────
  if (QUIZ_CADENCE_ENABLED) {
    await checkQuizCadence();
  } else {
    await clearPendingQuizCadence();
  }

  if (dossiesRecovered + followupsRecovered > 0) {
    console.log(`✅ [recovery] ${dossiesRecovered} dossiê(s) e ${followupsRecovered} follow-up(s) recuperados`);
  } else {
    console.log('✅ [recovery] Nenhum timer pendente encontrado');
  }
}

app.listen(config.port, async () => {
  console.log(`
🚀 SDR WhatsApp rodando na porta ${config.port}

Endpoints:
  POST /webhook/lead     → Recebe leads do Make (formulário)
  POST /webhook/quiz     → Recebe leads do quiz (aquisicao-table)
  POST /webhook/zapi     → Recebe mensagens da Zapi
  POST /webhook/quiz-pre → Armazena dados do quiz
  POST /webhook/disparo  → Dispara dossiê personalizado
  POST /webhook/ticto    → Webhook de compras da Ticto
  POST /webhook/campanha-registro → Registra participante de campanha sazonal (Hub)
  POST /webhook/quiz-cadence/cancel → Cancela cadência pós-quiz
  GET  /track/:uuid      → Link de rastreio do follow-up
  GET  /health           → Status do servidor
  GET  /:file            → Propostas e dossiês gerados
  GET  /fotos/:file      → Fotos da equipe
  `);

  if (FOLLOWUP_6H_ENABLED) {
    startFollowUpJob();
  } else {
    await clearPendingFollowUps();
  }
  startQuizCadenceJob();
  recoverPendingTimers().catch(err => console.error('❌ Erro na recovery de timers:', err.message));

  setInterval(async () => {
    const brasilia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const hora = brasilia.getHours();
    const minuto = brasilia.getMinutes();
    if (hora === 8 && minuto === 0) {
      const phones = await getPhonesWithQueue();
      for (const phone of phones) {
        await processQueue(phone);
      }
    }
  }, 60 * 1000);
});
