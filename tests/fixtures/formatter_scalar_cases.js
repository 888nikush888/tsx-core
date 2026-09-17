import assert from 'node:assert/strict';
export function verifyFormatterScalarBoundaries(formatters, legacy = null) {
  const cases = [
    ['summary accounts','formatSummary',{accounts:{total:2}},['accounts','total']],
    ['summary positions','formatSummary',{positions:{active:1}},['positions','active']],
    ['summary intents','formatSummary',{intents:{active:3}},['intents','active']],
    ['summary incidents','formatSummary',{incidents:{open:0}},['incidents','open']],
    ['position quantity','formatPositions',{positions:[{quantity:'1.25'}]},['positions',0,'quantity']],
    ['position entry','formatPositions',{positions:[{averageEntryPrice:'100.50'}]},['positions',0,'averageEntryPrice']],
    ['position stop','formatPositions',{positions:[{stopPrice:'95'}]},['positions',0,'stopPrice']],
    ['order filled','formatOrders',{orders:[{filledQuantity:'0.5',quantity:'1'}]},['orders',0,'filledQuantity']],
    ['order quantity','formatOrders',{orders:[{filledQuantity:'0.5',quantity:'1'}]},['orders',0,'quantity']],
    ['performance trades','formatPerformance',{groups:[{trades:2}]},['groups',0,'trades']],
    ['account currency','formatAccounts',{accounts:[{equity:'20',reportingCurrency:'USD'}]},['accounts',0,'reportingCurrency']],
    ['account equity','formatAccounts',{accounts:[{equity:'20',reportingCurrency:'USD'}]},['accounts',0,'equity']],
    ['system incidents','formatSystem',{openIncidents:2},['openIncidents']],
  ];
  let validComparisons=0, malformedCases=0, legacyCoercionReads=0;
  const replace=(base,keys,value)=>{const clone=structuredClone(base);let parent=clone;for(const key of keys.slice(0,-1))parent=parent[key];parent[keys.at(-1)]=value;return clone;};
  for(const [label,name,payload,keys] of cases){
    if(legacy){assert.equal(formatters[name](payload),legacy[name](payload),label);validComparisons++;}
    let reads=0;const hostile=Object.defineProperty({},Symbol.toPrimitive,{get(){reads++;throw new Error(`must not coerce ${label}`);}});
    const changed=replace(payload,keys,hostile);assert.match(formatters[name](changed),/ungeklärt/,label);assert.equal(reads,0,label);
    if(legacy){assert.throws(()=>legacy[name](changed),/must not coerce/);assert.equal(reads,1,label);legacyCoercionReads+=reads;}
    malformedCases++;
    for(const bad of [[],Object(2),()=>{/* malformed-value fixture: functions are not formatter scalars */},Symbol('invalid'),2n]){assert.match(formatters[name](replace(payload,keys,bad)),/ungeklärt/,label);malformedCases++;}
  }
  const additional=[['formatSummary',{}],['formatSummary',{accounts:null}],['formatOrders',{orders:[{filledQuantity:0}]}],['formatPositions',{positions:[{quantity:null,averageEntryPrice:null,stopPrice:null}]}],['formatAccounts',{accounts:[{equity:null}]}]];
  for(const [name,payload] of additional){if(name==='formatPositions'){assert.match(formatters[name](payload),/Menge: ungeklärt/);continue;}if(legacy){assert.equal(formatters[name](payload),legacy[name](payload));validComparisons++;}}
  return {validComparisons,malformedCases,legacyCoercionReads};
}
