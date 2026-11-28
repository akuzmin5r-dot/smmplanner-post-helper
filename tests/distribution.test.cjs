const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const names = ['smmplanner-mobile.user.js', 'smmplanner-tampermonkey.user.js'];
assert.deepEqual(fs.readdirSync(root).filter(n => n.endsWith('.user.js')).sort(), names);
for (const name of names) {
  const source = fs.readFileSync(path.join(root, name), 'utf8');
  new vm.Script(source, { filename: name });
  for (const directive of ['updateURL', 'downloadURL']) {
    const line = source.split(/\r?\n/).find(line => line.startsWith(`// @${directive} `));
    assert.equal(line?.trim().split(/\s+/).at(-1), `https://raw.githubusercontent.com/akuzmin5r-dot/smmplanner-post-helper/main/${name}`);
  }
  assert(!/ibssh_|access_token\s*[=:]|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/.test(source));
}
assert(!fs.existsSync(path.join(root, 'extension')));
assert(!fs.existsSync(path.join(root, 'new-editor-extension')));
console.log('PASS: exactly two parseable installation files, stable update URLs, no obsolete packages or embedded credentials');
