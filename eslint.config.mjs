import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ["src/clients/js/**"] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
);
