import { defineConfig } from 'vite';

// GitHub Pages serves the site from /<repo-name>/; the deploy workflow sets BASE_PATH accordingly.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
});
