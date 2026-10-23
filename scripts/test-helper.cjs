const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, mocks = {}, globals = {}) {
  const filename = path.resolve(__dirname, '..', file);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports,
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : name.startsWith('.') ? load(path.relative(path.resolve(__dirname, '..'), path.resolve(path.dirname(filename), name + '.ts')), mocks, globals) : require(name),
    Response, Request, AbortSignal, Buffer, console: { error() {}, log() {} },
    process: { env: { STRIPE_SECRET_KEY: 'sk_test_fake', DISCORD_PUBLIC_KEY: 'test', AUTHORIZED_DISCORD_USER_IDS: 'owner' } },
    ...globals,
  });
  vm.runInContext(code, context, { filename });
  return module.exports;
}


module.exports = { load };
