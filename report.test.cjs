const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('smmplanner-tampermonkey.user.js','utf8');
const start=source.indexOf('  const firstLine'),end=source.indexOf('  function titleOf');
const context={URL,Set,String,Error};
vm.runInNewContext(source.slice(start,end)+';this.reportOf=reportOf;',context);
function modal(text,urls){return {querySelector:()=>({value:text}),querySelectorAll:()=>urls.map(href=>({href}))}}
assert.equal(context.reportOf(modal('\r\n Headline \r\nBody',['https://one.invalid/post/1','https://two.invalid/post/2','https://three.invalid/post/3'])),'Headline\n\nhttps://one.invalid/post/1\nhttps://two.invalid/post/2\nhttps://three.invalid/post/3');
assert.equal(context.reportOf(modal('', ['https://one.invalid/p','https://one.invalid/p','javascript:alert(1)','https://user:password@one.invalid/p'])),'https://one.invalid/p');
assert.throws(()=>context.reportOf(modal('Title',[])),/Опубликованных ссылок пока нет/);
assert.throws(()=>context.reportOf({querySelector:()=>null}),/Не найден полный текст/);
console.log('PASS: arbitrary published links, headline, line spacing, deduplication, unsafe URL rejection, empty/missing data');

const actionSource=source.slice(source.indexOf('  function invokeNativeOk('),source.indexOf('  function enhanceEditor('));
const actionContext={};vm.runInNewContext(actionSource+';this.invoke=invokeNativeOk;',actionContext);
let clicks=0;const native={isConnected:true,disabled:false,getAttribute:()=>null,click:()=>clicks++};const actionModal={querySelector:()=>native};
native.disabled=true;assert.equal(actionContext.invoke(actionModal),false);assert.equal(clicks,0);
native.disabled=false;native.isConnected=false;assert.equal(actionContext.invoke(actionModal),false);assert.equal(clicks,0);
native.isConnected=true;
native.getAttribute=()=> 'true';assert.equal(actionContext.invoke(actionModal),false);assert.equal(clicks,0);
native.getAttribute=()=>null;assert.equal(actionContext.invoke(actionModal),true);assert.equal(clicks,1);
const densitySource=source.slice(source.indexOf('  function syncDensity('),source.indexOf('  function autoSummary('));
let density='';const densityContext={document:{documentElement:{clientWidth:980,style:{getPropertyValue:()=>density,setProperty:(name,value)=>{density=value}}}},screen:{width:390},matchMedia:()=>({matches:true}),visualViewport:{scale:0.4},Math,String};
vm.runInNewContext(densitySource+';this.sync=syncDensity;',densityContext);
densityContext.sync();const fixed=density;densityContext.visualViewport.scale=2;densityContext.sync();assert.equal(density,fixed);
console.log('PASS: native action respects disabled/disconnected controls (stub only); CSS density stays fixed during pinch zoom');

const footerSource=source.slice(source.indexOf('  function footerKey('),source.indexOf('  function addPaste('));
const footerContext={};vm.runInNewContext(footerSource+';this.trim=trimSubscriptionFooter;',footerContext);
const trim=footerContext.trim, body='🚤 Заголовок\n\nТекст со ссылкой https://example.invalid/source.\n\nПоследнее предложение.';
for(const footer of [
 'Подписывайтесь на Городские новости',
 '[Подписывайтесь на Городские новости](https://max.ru/example_channel)',
 'Подписывайтесь на Городские новости (https://max.ru/example_channel)',
 '[Городские новости](https://t.me/example_channel) / [Подписаться в MAX](https://max.ru/example_channel)',
 'Городские новости / Подписаться в MAX',
 'Городские новости (https://t.me/example_channel) / Подписаться в MAX (https://max.ru/example_channel)',
 'Подписаться в MAX'
]){assert.equal(trim(body+'\n\n'+footer).text,body,footer);}
assert.equal(trim(body+'  [Подписывайтесь на Городские новости](https://max.ru/example_channel)').text,body);
assert.equal(trim(body+'  [Городские новости](https://t.me/example_channel) / [Подписаться в MAX](https://max.ru/example_channel)').text,body);
for(const text of [body,body+'\n\nИсточник: https://example.invalid/source','Он сказал: «Подписывайтесь на Городские новости».','Подписывайтесь на обновления, если хотите узнать результат.',body+'\n\nhttps://max.ru/example_channel']){
 assert.equal(trim(text).text,text);assert.equal(trim(text).removed,false);
}
const original=body+'\n\nПодписаться в MAX';
assert.equal(trim(original,{footerTrim:false}).text,original);
assert.equal(trim(body+'\n\nЛокальная подпись',{footerSignatures:['Локальная подпись']}).text,body);
assert.equal(trim(body+'\n\nПодписаться в MAX\n\nПодписаться в MAX').text,body);
assert.equal(trim('[🚤](https://st.max.ru/emojis/1F6A4_32.webp) **Заголовок**.\n\nПодписаться в MAX').text,'[🚤](https://st.max.ru/emojis/1F6A4_32.webp) **Заголовок**.');
console.log('PASS: subscription footer formats, inline tail, body preservation, opt-out, local signatures, repeated tails');
