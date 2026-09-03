import crypto from 'crypto';
import { safeDel,safeGet,safeKeys,safeSet } from '../redis.js';
import { addMessage,isBlocked,setCommercialState } from '../conversation/store.js';
import { registrarEventoEvelyn } from '../hub/client.js';
import { sendMessage } from '../zapi/sender.js';

const PREFIX='pending_evelyn_journey:';
const MIN_DELAY_MS=20*60*1000;
const MAX_DELAY_MS=30*60*1000;
const timers=new Map();

function scheduleTimer(phone,fireAt){
  if(timers.has(phone))clearTimeout(timers.get(phone));
  const delay=Math.max(0,fireAt-Date.now());
  const timer=setTimeout(()=>deliverEvelynJourney(phone).catch(err=>console.error('[evelyn] envio agendado falhou:',err.message)),delay);
  timers.set(phone,timer);
}

export async function scheduleEvelynJourney({phone,leadData,journey}){
  const delay=MIN_DELAY_MS+Math.floor(Math.random()*(MAX_DELAY_MS-MIN_DELAY_MS+1));
  const pending={phone,leadData,journey,fire_at:Date.now()+delay,created_at:Date.now()};
  await safeSet(PREFIX+phone,JSON.stringify(pending),'EX',60*60*24*2);
  scheduleTimer(phone,pending.fire_at);
  return pending.fire_at;
}

export async function deliverEvelynJourney(phone){
  const key=PREFIX+phone;
  const raw=await safeGet(key);
  if(!raw)return false;
  const pending=JSON.parse(raw);
  if(pending.fire_at>Date.now()){scheduleTimer(phone,pending.fire_at);return false;}
  if(await isBlocked(phone)){await safeDel(key);return false;}
  const lock=await safeSet(`${key}:lock`,'1','NX','EX',120);
  if(!lock)return false;
  try{
    const message=`Sua Jornada personalizada com a Evelyn ficou pronta. Preparei essa apresentação a partir do que você compartilhou:\n\n${pending.journey.url}`;
    await sendMessage(phone,message);
    await addMessage(phone,'assistant',message);
    await setCommercialState(phone,{stage:'journey_sent',journeyUrl:pending.journey.url,journeySentAt:new Date().toISOString()});
    await registrarEventoEvelyn({eventId:crypto.randomUUID(),eventType:'evelyn_journey_sent',phone,leadData:pending.leadData,payload:{journey_url:pending.journey.url}});
    await safeDel(key);
    timers.delete(phone);
    return true;
  }catch(error){
    scheduleTimer(phone,Date.now()+5*60*1000);
    throw error;
  }finally{await safeDel(`${key}:lock`);}
}

export async function recoverPendingEvelynJourneys(){
  const keys=await safeKeys(`${PREFIX}*`);
  let recovered=0;
  for(const key of keys){
    if(key.endsWith(':lock'))continue;
    const raw=await safeGet(key);
    if(!raw)continue;
    try{const pending=JSON.parse(raw);if(!pending.phone||!pending.fire_at)continue;scheduleTimer(pending.phone,pending.fire_at);recovered++;}catch{}
  }
  return recovered;
}
