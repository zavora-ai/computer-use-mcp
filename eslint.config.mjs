// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * Type-aware lint for the TypeScript server. `tsc --strict` already covers
 * assignability, so the rules enabled here are the ones the compiler cannot see:
 * unawaited promises, discarded results, and silently swallowed errors.
 *
 * Empty `catch {}` is permitted only with an explanatory comment inside, which is
 * the convention this codebase already follows for genuinely optional cleanup.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'native/**', 'node_modules/**', 'workers/**', 'libexec/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // A dropped promise in a desktop-automation dispatcher means an action
      // that silently never happened.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // Require a comment so an empty catch is a decision, not an oversight.
      'no-empty': ['error', { allowEmptyCatch: false }],
      // `const { omitted, ...record } = value` is how records are stripped before
      // persistence here, so the named siblings are meant to be unused.
      '@typescript-eslint/no-unused-vars': ['error', {
        ignoreRestSiblings: true,
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],

      // Deliberately relaxed: this codebase interoperates with untyped MCP
      // envelopes and NAPI results, where narrowing happens at explicit checks
      // rather than in the type system.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Stylistic rather than defect-finding, and noisy against the tool-result
      // payloads and NAPI surfaces this server is built around.
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
    },
  },
)
