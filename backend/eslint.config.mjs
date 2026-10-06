import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
  {
    // Nest resolves constructor parameters through runtime metadata, so these imports must stay value imports.
    files: ['src/**/*.module.ts', 'src/**/*.service.ts', 'src/**/*.controller.ts', 'src/**/*.guard.ts', 'src/**/*.filter.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
);
