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
