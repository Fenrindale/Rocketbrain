# Vue 3 workspace tools

Open a Vue project in a trusted workspace. Rocketbrain finds the nearest Vue package with local `node_modules` and uses the installed tools. It does not require another VS Code extension. Select Node.js on your PATH or set `rocketbrain.vue.nodePath` to the absolute executable. Use the Node.js version required by your project's Vite.

- **Check Vue Project** shows the chosen executable and project configuration for review, then runs `vue-tsc` on saved files. Vue and TypeScript issues appear in Problems. Rocketbrain prefers `tsconfig.app.json` when present. Set `"vueCompilerOptions": { "strictTemplates": true }` in that configuration for strict template diagnostics. [Vue TypeScript guide](https://vuejs.org/guide/typescript/overview.html)
- Set **Rocketbrain › Vue: Enable Definitions** in a trusted workspace to enable **Go to Definition** from a template's local component tag, simple interpolation, or direct binding to its `<script setup>` declaration. This loads the project's `@vue/compiler-sfc` and TypeScript in an independent Node process.
- **Start Vue Dev Server** asks before loading the project's Vite configuration and plugins. Rocketbrain starts the server on an available loopback port. Choose **Open Preview** to open the page and **Stop Vue Dev Server** to release the listener. [Vite dev server options](https://vite.dev/config/server-options)

Navigation covers local component imports and simple JavaScript or TypeScript script-setup bindings. Template aliases, scoped slots, complex expressions, preprocessors and language-server completion remain outside this workflow. Angular and React are separate support areas.
