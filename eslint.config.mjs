const browser = {
  chrome: 'readonly', globalThis: 'readonly', window: 'readonly', document: 'readonly', location: 'readonly', history: 'readonly',
  navigator: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  TextEncoder: 'readonly', TextDecoder: 'readonly', Blob: 'readonly', URL: 'readonly', crypto: 'readonly', indexedDB: 'readonly', IDBKeyRange: 'readonly',
  Intl: 'readonly', BigInt: 'readonly', Option: 'readonly', Event: 'readonly', confirm: 'readonly', btoa: 'readonly', importScripts: 'readonly',
  module: 'readonly', require: 'readonly'
};
const node = { process: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', fetch: 'readonly', WebSocket: 'readonly', URL: 'readonly', Buffer: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly', Blob: 'readonly', require: 'readonly', __dirname: 'readonly', globalThis: 'readonly', crypto: 'readonly', setImmediate: 'readonly' };

export default [
  { ignores: ['dist/', 'node_modules/', 'tests/e2e/fixture.mjs'] },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: browser },
    rules: { 'no-unused-vars': 'error', 'no-undef': 'error', 'no-unreachable': 'error', 'no-dupe-keys': 'error', eqeqeq: ['error', 'always', { null: 'ignore' }] }
  },
  {
    files: ['**/*.cjs', '**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, globals: node },
    rules: { 'no-unused-vars': 'error', 'no-undef': 'error' }
  }
];
