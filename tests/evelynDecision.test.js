import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.ANTHROPIC_API_KEY='test';
process.env.ZAPI_INSTANCE_ID='test';
process.env.ZAPI_TOKEN='test';
process.env.ZAPI_CLIENT_TOKEN='test';
process.env.SDR_PHONE='5511000000000';
process.env.WEBHOOK_SECRET='test';
const { explicitEvelynSignals,validEvelynTransition,evelynEligibility,hasExplicitMalePatientEvidence } = await import('../src/evelyn/decision.js');
const { buildRadarBaseline,radarCanRender } = await import('../src/evelyn/radar.js');

test('detecta somente intenção explícita de acompanhamento com Evelyn',()=>{
  assert.ok(explicitEvelynSignals('Quero acompanhamento direto com a Evelyn').length>0);
  assert.equal(explicitEvelynSignals('Quero uma nutricionista que me acolha').length,0);
  assert.equal(explicitEvelynSignals('Vi um vídeo da Evelyn').length,0);
});

test('jamais torna paciente masculino elegível para Evelyn',()=>{
  assert.equal(hasExplicitMalePatientEvidence({genero:'Masculino'}),true);
  assert.equal(hasExplicitMalePatientEvidence({},'Sou homem e quero passar com a Evelyn'),true);
  assert.equal(hasExplicitMalePatientEvidence({},'Meu marido é homem e quero passar com a Evelyn'),false);
  const result=evelynEligibility({phone:'5511999999999',source:'formulario',message:'Quero acompanhamento direto com a Evelyn',leadData:{sexo:'masculino'}});
  assert.equal(result.eligible,false);
  assert.equal(result.reason,'male_patient_not_eligible');
});

test('máquina de estados não deixa o modelo pular preço nem regredir',()=>{
  assert.equal(validEvelynTransition('candidate','evelyn_price_accepted'),false);
  assert.equal(validEvelynTransition('price_presented','evelyn_price_accepted'),true);
  assert.equal(validEvelynTransition('journey_sent','evelyn_interest_confirmed'),false);
});

test('o prompt não oferece mais a consulta avulsa antiga',async()=>{
  const prompt=await readFile(new URL('../config/prompts/sdr.txt',import.meta.url),'utf8');
  assert.doesNotMatch(prompt,/R\$\s*600|consulta avulsa com a Evelyn/i);
  assert.match(prompt,/R\$\s*4\.800/);
});

test('checkout InfinitePay está no exemplo público',async()=>{
  const html=await readFile(new URL('../public/evelyn-exemplos/emocional.html',import.meta.url),'utf8');
  assert.match(html,/checkout\.infinitepay\.io\/tableclinic\/Fllvy2wB2O/);
  assert.match(html,/Exemplo fictício/);
  assert.match(html,/\/fotos\/evelyn-liu\.png/);
  assert.match(html,/LIA: registros, reflexões e intervenções/);
});

test('radar usa régua fixa, evidência e assume dados insuficientes',()=>{
  const sparse=buildRadarBaseline('Quero passar com a Evelyn');
  assert.equal(radarCanRender(sparse),false);
  assert.ok(sparse.dimensions.every(d=>d.score===null));
  const rich=buildRadarBaseline('Eu percebo a ansiedade como gatilho. Faço jejum e sigo regras, mas não consigo manter e recomeço. À noite perco o controle por cansaço.');
  assert.equal(radarCanRender(rich),true);
  assert.ok(rich.dimensions.some(d=>d.evidence.length>0));
  assert.ok(rich.dimensions.every(d=>d.score===null||(d.score>=1&&d.score<=5)));
  assert.ok(rich.dimensions.every(d=>d.score===null||d.objective===Math.min(5,d.score+2)));
});
