import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ["src/clients/**"] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["scripts/**/*.js"],
    languageOptions: {
      globals: {
        fetch: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        TextEncoder: "readonly",
      },
    },
  },
);
