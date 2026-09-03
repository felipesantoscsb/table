import crypto from 'crypto';
import { config } from '../../config/index.js';

const DIRECT=[/\b(quero|queria|gostaria|busco|vim para|procuro)\b.{0,45}\b(com|pela|a)\s+evelyn\b/i,/\bé\s+a\s+evelyn\s+que\s+(atende|vai\s+me\s+atender)\b/i,/\bacompanhamento\s+(direto\s+)?com\s+(a\s+)?evelyn\b/i,/\bpassar\s+com\s+(a\s+)?evelyn\b/i];
export function explicitEvelynSignals(text=''){
  const clean=String(text).replace(/\s+/g,' ').trim();
  return DIRECT.filter(r=>r.test(clean)).map((_,i)=>`explicit_evelyn_${i+1}`);
}
function bucket(phone){return parseInt(crypto.createHash('sha256').update(String(phone)).digest('hex').slice(0,8),16)%100;}
export function evelynEligibility({phone,source,message,history=[]}){
  const signals=explicitEvelynSignals([message,...history.filter(x=>x.role==='user').map(x=>x.content)].join('\n'));
  if(!signals.length)return {eligible:false,considered:false,reason:'no_explicit_intent',signals};
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
