import crypto from 'crypto';
import { config } from '../../config/index.js';

const DIRECT=[/\b(quero|queria|gostaria|busco|vim para|procuro)\b.{0,45}\b(com|pela|a)\s+evelyn\b/i,/\bé\s+a\s+evelyn\s+que\s+(atende|vai\s+me\s+atender)\b/i,/\bacompanhamento\s+(direto\s+)?com\s+(a\s+)?evelyn\b/i,/\bpassar\s+com\s+(a\s+)?evelyn\b/i];
export function explicitEvelynSignals(text=''){
  const clean=String(text).replace(/\s+/g,' ').trim();
  return DIRECT.filter(r=>r.test(clean)).map((_,i)=>`explicit_evelyn_${i+1}`);
}
export function hasExplicitMalePatientEvidence(leadData={},message='',history=[]){
  const declared=[leadData.genero,leadData.gênero,leadData.gender,leadData.sexo,leadData.respostas?.genero,leadData.respostas?.gênero,leadData.respostas?.gender,leadData.respostas?.sexo]
    .filter(v=>v!==null&&v!==undefined).map(v=>String(v).trim().toLowerCase());
  if(declared.some(v=>/^(masculino|masculina|male|homem|man|m)$/.test(v)))return true;
  const ownWords=[message,...history.filter(x=>x.role==='user').map(x=>x.content)].join('\n');
  return /\b(?:sou|eu sou|me identifico como)\s+(?:um\s+)?(?:homem|masculino)\b/i.test(ownWords);
}
function bucket(phone){return parseInt(crypto.createHash('sha256').update(String(phone)).digest('hex').slice(0,8),16)%100;}
export function evelynEligibility({phone,source,message,history=[],leadData={}}){
  const signals=explicitEvelynSignals([message,...history.filter(x=>x.role==='user').map(x=>x.content)].join('\n'));
  if(!signals.length)return {eligible:false,considered:false,reason:'no_explicit_intent',signals};
  if(hasExplicitMalePatientEvidence(leadData,message,history))return {eligible:false,considered:true,reason:'male_patient_not_eligible',signals};
  if(!config.evelyn.enabled)return {eligible:false,considered:true,reason:'feature_disabled',signals};
  if(config.evelyn.allowedSources.length&&!config.evelyn.allowedSources.some(x=>String(source||'').toLowerCase().includes(x)))return {eligible:false,considered:true,reason:'source_outside_pilot',signals};
  if(bucket(phone)>=config.evelyn.pilotPercent)return {eligible:false,considered:true,reason:'outside_pilot_bucket',signals};
  return {eligible:true,considered:true,reason:'explicit_intent',signals};
}
export const EVELYN_EVENTS=new Set(['evelyn_candidate','evelyn_interest_confirmed','evelyn_price_presented','evelyn_price_accepted','evelyn_declined_price','evelyn_declined_other','evelyn_routed_to_table']);

const TRANSITIONS={
  candidate:new Set(['evelyn_candidate','evelyn_interest_confirmed','evelyn_declined_other','evelyn_routed_to_table']),
  interest_confirmed:new Set(['evelyn_interest_confirmed','evelyn_price_presented','evelyn_declined_other','evelyn_routed_to_table']),
  price_presented:new Set(['evelyn_price_presented','evelyn_price_accepted','evelyn_declined_price','evelyn_declined_other','evelyn_routed_to_table']),
  price_accepted:new Set(['evelyn_price_accepted']),
  journey_sent:new Set([]),
};
export function validEvelynTransition(stage,event){return Boolean(EVELYN_EVENTS.has(event)&&(TRANSITIONS[stage||'candidate']||new Set()).has(event));}
