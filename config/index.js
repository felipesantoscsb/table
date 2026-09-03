// config/index.js
// Centraliza todas as configurações do sistema.

function required(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Variável de ambiente obrigatória não definida: ${name}`);
  return val;
}

export const config = {
  port: process.env.PORT || 3000,

  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
    model: 'claude-sonnet-4-5',
  },

  zapi: {
    instanceId: required('ZAPI_INSTANCE_ID'),
    token: required('ZAPI_TOKEN'),
    clientToken: required('ZAPI_CLIENT_TOKEN'),
    baseUrl: () =>
      `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}`,
  },

  sdr: {
    phone: required('SDR_PHONE'),
  },

  webhook: {
    secret: required('WEBHOOK_SECRET'),
  },

  evelyn: {
    enabled: process.env.EVELYN_BRANCH_ENABLED === 'true',
    pilotPercent: Math.min(100, Math.max(0, Number(process.env.EVELYN_BRANCH_PILOT_PERCENT || 100))),
    allowedSources: String(process.env.EVELYN_BRANCH_ALLOWED_SOURCES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    checkoutUrl: process.env.EVELYN_CHECKOUT_URL || 'https://checkout.infinitepay.io/tableclinic/Fllvy2wB2O',
    price: Number(process.env.EVELYN_PRICE_BRL || 4800),
    journeyBaseUrl: process.env.EVELYN_JOURNEY_BASE_URL || 'https://jornada.tableclinic.com.br',
  },

  // 90s — aguarda mais mensagens antes de processar
  aggregationDelay: 90_000,
};
