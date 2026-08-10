import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const basisRoot = fileURLToPath(new URL('../../packages/three/node_modules/three/examples/jsm/libs/basis/', import.meta.url));
const basisAssets = ['basis_transcoder.js', 'basis_transcoder.wasm'] as const;

function basisTranscoderAssets(): Plugin {
  return {
    name: 'worldengine-basis-transcoder-assets',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = request.url?.split('?', 1)[0];
        const asset = basisAssets.find((name) => pathname === `/basis/${name}`);
        if (!asset) { next(); return; }
        try {
          const bytes = await readFile(resolve(basisRoot, asset));
          response.statusCode = 200;
          response.setHeader('content-type', asset.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8');
          response.setHeader('content-length', bytes.byteLength);
          response.end(bytes);
        } catch (error) { next(error as Error); }
      });
    },
    async generateBundle() {
      for (const asset of basisAssets) this.emitFile({ type: 'asset', fileName: `basis/${asset}`, source: await readFile(resolve(basisRoot, asset)) });
    },
  };
}

export default defineConfig({
  plugins: [react(), basisTranscoderAssets()],
  server: { port: 5173 },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1200 },
});
