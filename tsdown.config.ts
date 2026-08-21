import { defineConfig } from 'tsdown'

const packageName = '@creative-dswork/dsh-uni-editor'

export default defineConfig([
  {
    name: packageName,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: false,
    fixedExtension: false,
  },
  {
    name: `${packageName}/client`,
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    sourcemap: false,
    minify: true,
    deps: {
      neverBundle: [
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-client-ui-slots',
        'react',
        'react/jsx-runtime',
        'react-dom',
        'react-dom/client',
      ],
      alwaysBundle: [/^@modelcontextprotocol\//, /^zod(?:\/|$)/],
      onlyBundle: [
        '@modelcontextprotocol/sdk',
        '@modelcontextprotocol/ext-apps',
        'zod',
      ],
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
  {
    name: `${packageName}/demo-view`,
    entry: { view: 'demo/view.ts' },
    outDir: 'demo/dist',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    sourcemap: false,
    minify: true,
    deps: {
      alwaysBundle: () => true,
      onlyBundle: false,
    },
    outputOptions: {
      entryFileNames: 'view.js',
    },
  },
  {
    name: `${packageName}/demo-server`,
    entry: { server: 'demo/server.ts' },
    outDir: 'demo/dist',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: false,
    fixedExtension: false,
    outputOptions: {
      entryFileNames: 'server.js',
    },
  },
])
