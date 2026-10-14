/**
 * build-offline.mjs
 * ------------------------------------------------------------------
 * Builds a fully self-contained, offline-capable single HTML file
 * (prosthoviz_offline.html) from the editable source (prosthoviz.html).
 *
 * Everything that normally comes from a CDN is downloaded once into
 * ./vendor and then inlined into the output:
 *   - Tailwind CSS        -> pre-compiled static CSS (no runtime JS)
 *   - three.js r128       -> inlined <script>
 *   - Font Awesome 6.4.0  -> CSS + the two used webfonts inlined as base64
 *   - Google Fonts        -> dropped; the page falls back to system fonts
 *                            (Microsoft YaHei / PingFang SC on hospital PCs)
 *
 * Usage:  node build-offline.mjs
 * Requires Node 18+ and network access on the machine that builds
 * (the generated file itself needs no network).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(__dirname, 'vendor');
const FONT_DIR = path.join(VENDOR, 'webfonts');
fs.mkdirSync(FONT_DIR, { recursive: true });

const SOURCE = path.join(__dirname, 'prosthoviz.html');
const OUTPUT = path.join(__dirname, 'prosthoviz_offline.html');

const FA_VERSION = '6.4.0';
const URLS = {
  three: 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
  faCss: `https://cdnjs.cloudflare.com/ajax/libs/font-awesome/${FA_VERSION}/css/all.min.css`,
  faFontBase: `https://cdnjs.cloudflare.com/ajax/libs/font-awesome/${FA_VERSION}/webfonts/`,
};

// Only these two fonts are actually used (fa-solid + fa-regular icons).
const NEEDED_FONTS = ['fa-solid-900.woff2', 'fa-regular-400.woff2'];

async function fetchToFile(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    return fs.readFileSync(dest);
  }
  process.stdout.write(`   downloading ${path.basename(dest)} ... `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`${(buf.length / 1024).toFixed(0)} KB`);
  return buf;
}

console.log('1/4  Downloading libraries');
const threeJs = (await fetchToFile(URLS.three, path.join(VENDOR, 'three.min.js'))).toString('utf8');
const faCssRaw = (await fetchToFile(URLS.faCss, path.join(VENDOR, 'fontawesome-all.min.css'))).toString('utf8');

console.log('2/4  Inlining Font Awesome webfonts (base64)');
for (const ref of NEEDED_FONTS) {
  await fetchToFile(URLS.faFontBase + ref, path.join(FONT_DIR, ref));
}
// Drop the larger .ttf fallbacks; every target browser supports woff2.
let faCss = faCssRaw.replace(/,\s*url\(\.\.\/webfonts\/[^)]+\.ttf\)\s*format\("truetype"\)/g, '');
// Inline only the fonts we use. Unused families (brands / v4 shims) keep their
// relative URL and are never fetched because no icon uses those families.
faCss = faCss.replace(/url\((['"]?)\.\.\/webfonts\/([^)"']+)\1\)/g, (match, _q, file) => {
  const full = path.join(FONT_DIR, file);
  if (!NEEDED_FONTS.includes(file) || !fs.existsSync(full)) return match;
  const b64 = fs.readFileSync(full).toString('base64');
  return `url(data:font/woff2;base64,${b64})`;
});

console.log('3/4  Compiling Tailwind CSS');
execSync(
  `npx --yes tailwindcss@3.4.17 -c tailwind.config.cjs -i tailwind.input.css -o "${path.join(VENDOR, 'tailwind.css')}" --minify`,
  { cwd: __dirname, stdio: 'inherit' }
);
const tailwindCss = fs.readFileSync(path.join(VENDOR, 'tailwind.css'), 'utf8');

console.log('4/4  Building single-file offline HTML');
let html = fs.readFileSync(SOURCE, 'utf8');
const sourceSize = html.length;

// Replace each CDN tag with its inlined equivalent (same position in <head>).
// NOTE: always use a replacer *function* — three.js/CSS contain `$` sequences
// that would otherwise be interpreted as special replacement patterns.
html = html
  .replace(/<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>/, '')
  .replace(
    /<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/three\.js\/r128\/three\.min\.js"><\/script>/,
    () => `<script>\n${threeJs}\n</script>`
  )
  .replace(
    /<link rel="stylesheet" href="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome\/6\.4\.0\/css\/all\.min\.css">/,
    () => `<style>\n${faCss}\n</style>`
  )
  .replace(/[ \t]*<link href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]*" rel="stylesheet">\r?\n/, '');

// Tailwind must come LAST so its utility classes win ties against the page's
// own rules — this reproduces the ordering the CDN injected at runtime.
html = html.replace('</head>', () => `<style>\n${tailwindCss}\n</style>\n</head>`);

fs.writeFileSync(OUTPUT, html);

const leftover = [...new Set([...html.matchAll(/https?:\/\/[^"'\s<>)]+/g)].map((m) => m[0]))];
console.log(`\nDone -> ${path.basename(OUTPUT)}`);
console.log(`Source : ${(sourceSize / 1024).toFixed(0)} KB`);
console.log(`Output : ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB`);
if (leftover.length) {
  console.log('Remaining absolute URLs (comments / inert namespace only):');
  for (const u of leftover.slice(0, 8)) console.log('   ' + u);
} else {
  console.log('No remaining absolute URLs — 100% offline.');
}
