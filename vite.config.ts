import { defineConfig, type Plugin } from 'vite';

/**
 * The shipped build must run by double-clicking the file (file:// protocol),
 * offline, with zero network requests.
 *
 * Two things break that by default:
 *  1. Separate .js/.css files — a file:// page can't reliably fetch siblings,
 *     so every chunk and stylesheet is inlined into the HTML itself.
 *  2. `<script type="module">` — browsers apply CORS to module scripts, and a
 *     file:// page has a null origin. The bundle is emitted as an IIFE and the
 *     script tag is left as a classic script.
 *
 * The inlining is done here rather than via a plugin so the failure mode is
 * visible: if a chunk isn't matched and inlined, the build throws instead of
 * quietly shipping an HTML file with an empty <script> tag.
 */
function inlineIntoSingleFile(outputName: string): Plugin {
  return {
    name: 'inline-into-single-file',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const htmlEntry = Object.values(bundle).find(
        (f) => f.type === 'asset' && f.fileName.endsWith('.html'),
      );
      if (!htmlEntry || htmlEntry.type !== 'asset') {
        throw new Error('single-file build: no HTML asset found in the bundle');
      }

      let html = String(htmlEntry.source);

      for (const [key, file] of Object.entries(bundle)) {
        if (file === htmlEntry) continue;
        const name = escapeRegExp(file.fileName);

        if (file.type === 'chunk') {
          // A literal </script> inside the code would close the tag early.
          const code = file.code.replace(/<\/script/gi, '<\\/script');
          const tag = new RegExp(`<script[^>]*\\bsrc="[^"]*${name}"[^>]*>\\s*</script>`, 'g');
          if (!tag.test(html)) {
            throw new Error(`single-file build: no <script> tag referencing ${file.fileName}`);
          }
          tag.lastIndex = 0;
          html = html.replace(tag, () => `<script>${code}</script>`);
        } else if (file.fileName.endsWith('.css')) {
          const link = new RegExp(`<link[^>]*\\bhref="[^"]*${name}"[^>]*>`, 'g');
          html = html.replace(link, () => `<style>${String(file.source)}</style>`);
        } else {
          continue; // leave anything else alone
        }

        delete bundle[key];
      }

      // Classic script, and no absolute paths that a file:// page can't resolve.
      html = html.replace(/<script\s+type="module"/g, '<script');
      html = html.replace(/\s+crossorigin(?==|\s|>)/g, '');
      html = html.replace(/(src|href)="\/(?!\/)/g, '$1="./');

      if (/<script[^>]*\bsrc=/.test(html) || /<link[^>]*rel="stylesheet"/.test(html)) {
        throw new Error('single-file build: external references remain in the output');
      }

      htmlEntry.source = html;
      htmlEntry.fileName = outputName;
    },
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default defineConfig({
  base: './',
  plugins: [inlineIntoSingleFile('flight-sim.html')],
  build: {
    target: 'es2020',
    modulePreload: false,
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    chunkSizeWarningLimit: 8000,
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: '[name][extname]',
      },
    },
  },
});
