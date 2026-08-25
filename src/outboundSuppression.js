// src/outboundSuppression.js
//
// Supressão cross-fluxo: evita que a mesma pessoa receba template de dois
// fluxos diferentes (Raiz e LIA) na mesma janela de tempo. Uma chave única
// por telefone, escrita por QUALQUER disparo que passe por markOutboundSent —
// hoje: dossiê do Raiz (fireDossie) e os dois templates da LIA.
//
// Não substitui isBlocked() (bloqueio explícito) nem nenhuma checagem de
// compra/assinatura já existente em cada fluxo — é só a trava de "não toca
// na mesma pessoa duas vezes num intervalo curto, venha de onde vier".

import { safeGet, safeSet } from './redis.js';

const SUPPRESSION_WINDOW_SEC = Number(process.env.OUTBOUND_SUPPRESSION_HOURS || 20) * 60 * 60;

function outboundKey(phone) {
  return `outbound:last_sent:${phone}`;
}

export async function wasRecentlyContacted(phone) {
  if (!phone) return false;
  const raw = await safeGet(outboundKey(phone));
  return Boolean(raw);
}

export async function markOutboundSent(phone) {
  if (!phone) return;
  await safeSet(outboundKey(phone), String(Date.now()), 'EX', SUPPRESSION_WINDOW_SEC);
}
