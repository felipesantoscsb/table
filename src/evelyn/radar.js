export const RADAR_VERSION='evelyn-radar-v1';

const DIMENSIONS=[
  {key:'trigger_awareness',label:'Consciência dos gatilhos',negative:[/não sei por que|do nada|sem perceber|automátic|gatilho/i],positive:[/percebo|identifico|reconheço|sei quando|noto que/i]},
  {key:'food_flexibility',label:'Flexibilidade alimentar',negative:[/restri|proib|8 ou 80|tudo ou nada|compens|jejum|culpa/i],positive:[/flexib|sem culpa|equilíbrio|equilibrio|permito|adapto/i]},
  {key:'choice_autonomy',label:'Autonomia nas escolhas',negative:[/dependo|não consigo escolher|plano rígido|cardápio|cardapio|regras/i],positive:[/consigo escolher|autonomia|decido|confio.*escolha/i]},
  {key:'possible_consistency',label:'Consistência possível',negative:[/não consigo manter|recomeç|sanfona|desisto|abandono|rotina caótica|rotina caotica/i],positive:[/mantenho|consist|regular|retomo|continuidade/i]},
  {key:'difficult_moments',label:'Recursos nos momentos difíceis',negative:[/ansiedad|estresse|cansaç|noite.*difícil|perco o controle|compuls/i],positive:[/pauso|peço ajuda|outra resposta|consigo lidar|me acolho/i]},
];

const clean=v=>String(v??'').replace(/\s+/g,' ').trim();
function snippets(text){return clean(text).split(/(?<=[.!?])\s+|\n+/).map(clean).filter(x=>x.length>=12).slice(0,80)}

function flattenText(value,path='input',output=[]){
  if(value===null||value===undefined)return output;
  if(Array.isArray(value)){
    value.forEach((item,index)=>flattenText(item,`${path}[${index}]`,output));
    return output;
  }
  if(typeof value==='object'){
    Object.entries(value).forEach(([key,item])=>flattenText(item,`${path}.${key}`,output));
    return output;
  }
  const text=clean(value);
  if(text.length>=12)snippets(text).forEach(note=>output.push({path,note}));
  return output;
}

export function buildRadarBaseline(input,source='sdr_history'){
  const pieces=typeof input==='string'
    ? snippets(input).map(note=>({path:'input',note}))
    : flattenText(input);
  const dimensions=DIMENSIONS.map(d=>{
    const evidence=[];let balance=0;
    for(const piece of pieces){
      const neg=d.negative.some(r=>r.test(piece.note));const pos=d.positive.some(r=>r.test(piece.note));
      if(!neg&&!pos)continue;
      balance+=(pos?1:0)-(neg?1:0);
      evidence.push({ref:`${source}:${piece.path}`,note:piece.note.slice(0,220),direction:pos&&!neg?'resource':neg&&!pos?'difficulty':'mixed'});
      if(evidence.length===3)break;
    }
    const confidence=evidence.length>=3?'high':evidence.length===2?'medium':evidence.length===1?'low':'insufficient';
    const score=!evidence.length?null:Math.max(1,Math.min(5,3+Math.sign(balance)));
    return {...d,key:d.key,label:d.label,score,objective:score===null?null:Math.min(5,score+1),confidence,evidence};
  }).map(({negative,positive,...d})=>d);
  return {version:RADAR_VERSION,scale:{min:1,max:5,direction:'higher_means_more_available_resource'},source,generated_at:new Date().toISOString(),dimensions,scored_dimensions:dimensions.filter(d=>d.score!==null).length};
}

export function radarCanRender(baseline){return baseline.dimensions.filter(d=>d.score!==null).length>=3}
