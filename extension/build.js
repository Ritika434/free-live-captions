// Bundles the extension into dist/ — the folder to "Load unpacked" in Chrome.
//
// Only offscreen.js has npm dependencies (@huggingface/transformers), so it's
// the only file that needs esbuild bundling. Everything else is plain script
// (no import syntax) and is copied as-is. The ONNX runtime's WASM/JSEP assets
// are copied locally too, rather than left pointing at transformers.js's
// default jsdelivr CDN default, so the extension never depends on a CDN at
// runtime (constitution.md §3, spec.md FR2/FR8).

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const SRC = path.join(__dirname, 'src');
const DIST = path.join(__dirname, 'dist');
const watch = process.argv.includes('--watch');

function clean() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
}

function copy(relSrc, relDest = relSrc) {
  const from = path.join(SRC, relSrc);
  const to = path.join(DIST, relDest);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

function copyOrtAssets() {
  const ortSrcDir = path.join(__dirname, 'node_modules', '@huggingface', 'transformers', 'dist');
  const ortDestDir = path.join(DIST, 'ort');
  fs.mkdirSync(ortDestDir, { recursive: true });
  const files = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];
  for (const f of files) {
    fs.copyFileSync(path.join(ortSrcDir, f), path.join(ortDestDir, f));
  }
}

const staticFiles = [
  'manifest.json',
  'background.js',
  'content.js',
  'content.css',
  'popup.html',
  'popup.css',
  'popup.js',
  'offscreen.html',
  'audio-worklet-processor.js',
];

async function build() {
  clean();
  staticFiles.forEach((f) => copy(f));
  copy('../icons', 'icons');
  copyOrtAssets();

  const opts = {
    entryPoints: [path.join(SRC, 'offscreen.js')],
    outfile: path.join(DIST, 'offscreen.js'),
    bundle: true,
    format: 'iife',
    target: 'chrome110',
    minify: false,
    logLevel: 'info',
  };

  if (watch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
    console.log('Watching for changes...');
  } else {
    await esbuild.build(opts);
    console.log(`Built extension -> ${DIST}`);
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
