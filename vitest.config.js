const { defineConfig } = require('vitest/config');

// Solo server/ por ahora — client/ tiene su propio package.json (build de Vite aparte) y no
// necesita este runner para nada todavía. Si en el futuro se agregan tests de componentes React,
// van a vivir en client/ con su propia config (jsdom, etc.), no acá.
module.exports = defineConfig({
  test: {
    include: ['server/**/*.test.js'],
    exclude: ['node_modules', 'client'],
    // El código bajo test es CommonJS (require, no import) — vitest en sí no se puede importar
    // con require() en un módulo CJS, así que describe/it/expect se inyectan como globals en vez
    // de importarlos, y los .test.js se quedan en CJS puro para poder requirear el módulo real.
    globals: true,
  },
});
