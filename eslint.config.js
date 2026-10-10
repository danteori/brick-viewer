import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const LITE_RULE = {
  selector: "Identifier[name='__LITE__']",
  message: '__LITE__ may only be used in src/app/features.ts. Ask features.ts which features are on instead.',
};

export default tseslint.config(
  { ignores: ['node_modules/', 'dist/', 'dist-lite/', 'site/', 'legacy/', 'test-results/', 'playwright-report/', 'tests/golden/', '.local/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  // App and test code: only features.ts may read the build flag. (The Vite configs define it.)
  { files: ['src/**/*.ts', 'tests/**/*.ts'], ignores: ['src/app/features.ts'], rules: { 'no-restricted-syntax': ['error', LITE_RULE] } },
  {
    // Node scripts; the golden script also passes functions into the page, which use the legacy
    // viewer's globals, so no-undef is off here.
    files: ['scripts/**/*.mjs', '*.config.js'],
    rules: { 'no-undef': 'off' },
  },
);
