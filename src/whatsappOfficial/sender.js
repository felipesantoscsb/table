import axios from 'axios';
import { isBlocked } from '../conversation/store.js';

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v25.0';
const GRAPH_URL = `https://graph.facebook.com/${API_VERSION}`;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável de ambiente obrigatória não definida: ${name}`);
  return value;
}

function bodyComponents(params = []) {
  const cleanParams = params.map(value => String(value || '').trim());
  if (!cleanParams.length) return undefined;
  return [{
    type: 'body',
    parameters: cleanParams.map(text => ({ type: 'text', text })),
  }];
}

function buttonComponents(buttonParams = []) {
  return buttonParams
    .map((value, index) => String(value || '').trim()
      ? {
          type: 'button',
          sub_type: 'url',
          index: String(index),
          parameters: [{ type: 'text', text: String(value).trim() }],
        }
      : null)
    .filter(Boolean);
}

export async function sendOfficialTemplate({ to, templateName, languageCode, params = [], buttonParams = [] }) {
  // Mesmo guard do canal Z-API: número bloqueado não recebe template oficial
  // (cadência do quiz, disparos), independente do que já estiver agendado.
  if (await isBlocked(to)) {
    console.log(`⛔ Template ${templateName} cancelado para ${to} (número bloqueado)`);
    return null;
  }
  const phoneNumberId = requireEnv('WHATSAPP_PHONE_NUMBER_ID');
  const token = requireEnv('WHATSAPP_ACCESS_TOKEN');
  const language = languageCode || process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'pt_BR';
  const components = [
    ...(bodyComponents(params) || []),
    ...buttonComponents(buttonParams),
  ];

  try {
    const response = await axios.post(`${GRAPH_URL}/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: language },
        ...(components.length ? { components } : {}),
      },
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    console.log(`✅ Template oficial ${templateName} enviado para ${to}`);
    return response.data;
  } catch (error) {
    const detail = error.response?.data || error.message;
    console.error(`❌ Erro ao enviar template oficial ${templateName} para ${to}:`, detail);
    throw error;
  }
}
