import gts from 'gts/build/src/index.js';

/**
 * ESLint flat config for switchback.
 *
 * The rule set is gts's (Google TypeScript Style) end to end. Three things are
 * adjusted, all because this repo predates gts and has a house style gts's
 * defaults would rewrite wholesale:
 *
 *  - **Type-aware rules need a tsconfig that contains the linted file.** gts
 *    points at `./tsconfig.json`, which in this repo includes only the root
 *    `index.ts` graph (see `src/AGENTS.md` -> Verification). Lint coverage must
 *    not depend on whether a module happens to be wired into the extension entry
 *    yet, so the parser is retargeted at `tsconfig.eslint.json`, which widens the
 *    include to `src/` and `tests/`. `TYPE_AWARE_ENTRY` below is gts's own
 *    type-aware entry, addressed by position so the rule set itself stays gts's.
 *  - **Quotes.** gts enforces single quotes; this codebase uses double quotes
 *    throughout (170 double-quoted assignments vs 2 single). The rule is
 *    relaxed to match, so it agrees with Prettier instead of fighting it.
 *  - **Ignores.** gts already skips `node_modules` and build output; the repo's
 *    `.git` and beads data are added.
 *
 * Formatting options are deliberately *not* set here beyond the quotes rule.
 * eslint-plugin-prettier resolves each file's nearest Prettier config, so the
 * repo's `.prettierrc.json` governs: it keeps the house style (tabs, 120
 * columns, double quotes, existing line endings) rather than gts's defaults
 * (2 spaces, 80 columns, single quotes, LF), which would reformat every file in
 * the tree for no gain.
 *
 * This file is ESM because package.json sets `"type": "module"`; gts is CommonJS,
 * so its config array arrives as the default import.
 *
 * `gts lint` and `gts fix` (mise tasks `lint-ts` / `format-ts`) run this.
 */
const TYPE_AWARE_ENTRY = 7;

export default [
  { ignores: ['.git/**', '.beads/**', 'node_modules/**', 'dist/**', 'coverage/**', 'eslint.config.js'] },
  ...gts.map((entry, index) =>
    index === TYPE_AWARE_ENTRY
      ? {
          ...entry,
          languageOptions: {
            ...entry.languageOptions,
            parserOptions: { ...entry.languageOptions.parserOptions, project: './tsconfig.eslint.json' },
          },
        }
      : entry,
  ),
  {
    rules: {
      quotes: ['warn', 'double', { avoidEscape: true }],
      // Underscore means "intentionally unused" (test fixture params, ignored
      // callback args). Without this, gts flags every one of them as dead code.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
];
