const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('extension/content.js','utf8');
const code=source.slice(source.indexOf('  function newsGridTracks('),source.indexOf('  const groupFooters'));
const tracks=vm.runInNewContext(code+';newsGridTracks');
const groups=[{key:'a',rows:[1,2]},{key:null,rows:[3]},{key:'b',rows:[4,5,6]}];
for(const stacked of [false,true]){
 const result=tracks(groups,stacked);
 assert.equal(result.length,3);
 assert.deepEqual(Array.from(result,x=>x.span),[2,1,3]);
 for(let i=0;i<result.length-1;i++) assert(result[i].gap+(stacked?1:0)<result[i+1].start);
 assert.deepEqual(Array.from(result,x=>x.start),stacked?[1,5,8]:[1,4,6]);
}
assert.equal(tracks([]).length,0);
console.log('PASS: card grid reserves independent publication rows and gaps at wide and stacked widths');
