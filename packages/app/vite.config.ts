import { defineConfig, type Plugin } from 'vite';
import {resolve} from 'node:path';
import {docsPlugin} from '../../tools/docs.mjs';

/** Isolation without the service worker in dev and preview (ADR 0013). */
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

const BASE = process.env['FEMLAB_BASE_PATH'] ?? '/fem-lab/';
const firebaseConfig = process.env['FEMLAB_FIREBASE_CONFIG'] ?? 'null';
const apiOrigin = process.env['FEMLAB_AI_API_ORIGIN'] ?? null;
const developmentAi = process.env['FEMLAB_AI_MODE'] === 'development';
if (developmentAi && apiOrigin) throw new Error('Development AI builds cannot target a hosted API.');

/** The sign-in host embeds Firebase's non-isolated reserved helper; the engine stays isolated. */
function isolationHeaders():Plugin {
  const install=(server:import('vite').ViteDevServer|import('vite').PreviewServer)=>{server.middlewares.use((request,response,next)=>{
    for(const [name,value] of Object.entries(headers))response.setHeader(name,value);
    if(new URL(request.url??'/', 'http://localhost').pathname===`${BASE}signin.html`)response.setHeader('Cross-Origin-Embedder-Policy','unsafe-none');
    next();
  });};
  return {name:'femlab-host-isolation',configureServer:install,configurePreviewServer:install};
}

export default defineConfig(({ command }) => ({
  base: BASE,
  worker: { format: 'es' },
  plugins: [docsPlugin(BASE),isolationHeaders(), {
    name: 'femlab-dev-csp',
    // Production keeps the static meta policy. Only the dev server needs HMR sockets.
    transformIndexHtml(html, ctx) {
      if (apiOrigin) html = html.replace("connect-src 'self' https://api.anthropic.com https://api.openai.com", `connect-src 'self' ${new URL(apiOrigin).origin} https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com`);
      if(ctx.filename.endsWith('/signin.html')&&firebaseConfig!=='null'){
        const authDomain=(JSON.parse(firebaseConfig) as {authDomain?:string}).authDomain;
        if(authDomain){const origin=new URL(`https://${authDomain}`).origin;if(origin!==`https://${authDomain}`)throw new Error('Firebase authDomain must be a hostname.');html=html.replace("frame-src 'none'",`frame-src ${origin}/__/auth/iframe`);}
      }
      return ctx.server ? html.replace("connect-src 'self'", "connect-src 'self' ws://localhost:* ws://127.0.0.1:* wss://localhost:*") : html;
    },
  }],
  build: {
    target: 'es2022',
    // The strict CSP permits only same-origin fonts, including the smallest KaTeX files.
    assetsInlineLimit: (filePath) => /\.(?:woff2?|ttf|otf|eot)$/i.test(filePath) ? false : undefined,
    // `tools/size-check.mjs` reads this to tell the landing chunk (the entry and its static
    // import closure) from everything that only arrives when someone asks for it.
    manifest: true,
    rollupOptions: {
      input:{index:resolve(import.meta.dirname,'index.html'),signin:resolve(import.meta.dirname,'signin.html')},
      output: {
        advancedChunks: {
          groups: [
            // Keep three.js separate so viewer changes do not invalidate the library cache.
            // ViewerPane loads both chunks only when a modeling workspace opens.
            // The AI SDKs get NO group: grouping them makes rolldown hoist the shared chunk into
            // the entry's *static* imports, which is exactly what this commit is removing.
            { name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/ },
          ],
        },
      },
    },
  },
  define: {
    __FIREBASE_CONFIG__: firebaseConfig,
    __AI_API_ORIGIN__: JSON.stringify(apiOrigin),
    __GOOGLE_SIGN_IN__: process.env['FEMLAB_GOOGLE_SIGN_IN'] === 'true' ? 'true' : 'false',
    __HOSTED_AI__: !developmentAi && (command === 'build' || apiOrigin !== null) ? 'true' : 'false',
    // Dev convenience only: the AI panel can pick a key up from the shell environment while
    // `vite dev` runs. A production build defines `null`, so no key can reach `dist/`
    // (`test/no-secrets.test.ts` checks the built files).
    __DEV_API_KEYS__:
      command === 'serve' && !apiOrigin
        ? JSON.stringify({
            anthropic: process.env['ANTHROPIC_API_KEY'] ?? null,
            openai: process.env['OPENAI_API_KEY'] ?? null,
          })
        : 'null',
  },
}));
