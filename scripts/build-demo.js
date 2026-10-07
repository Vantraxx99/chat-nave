#!/usr/bin/env node
'use strict';
// Genera un'anteprima statica in un unico file HTML (server simulato nel browser).
//
//   node scripts/build-demo.js [output.html]
//
// Serve solo per far provare grafica e funzionamento senza mettere online il server:
// i messaggi restano nel browser di chi la apre e gli altri partecipanti sono finti.

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const out = process.argv[2] || path.join(root, 'demo', 'anteprima.html');

const index = read('public/index.html');
const body = index.slice(index.indexOf('<body>') + 6, index.indexOf('<script src="/app.js">')).trim();
const title = index.match(/<title>(.*?)<\/title>/)[1];

const banner = `<div class="demo-banner">Anteprima: i messaggi e gli altri partecipanti sono simulati e restano solo su questo dispositivo.</div>`;
const extraCss = `
.demo-banner { position: fixed; left: 50%; transform: translateX(-50%); bottom: 8px; z-index: 30; max-width: calc(100% - 32px);
  background: var(--ink); color: #fff; font-size: 12px; padding: 6px 12px; border-radius: 999px; text-align: center; pointer-events: none; opacity: .92; }
#login.hidden ~ .demo-banner { display: none; }
`;
// Le immagini vengono incorporate come data URI: l'anteprima è un unico file.
const dataUri = (file, type) => `data:${type};base64,${fs.readFileSync(path.join(root, 'public', file)).toString('base64')}`;
const IMAGES = { '/wordmark.png': dataUri('wordmark.png', 'image/png'), '/waves.jpg': dataUri('waves.jpg', 'image/jpeg') };
const inlineImages = (text) => text.replace(/\/(wordmark\.png|waves\.jpg)/g, (m) => IMAGES[m]);

let html = `<title>${title}</title>
<style>
${read('public/style.css')}
${extraCss}
</style>
${body}
${banner}
<script>
${read('demo/demo.js')}
</script>
<script>
${read('public/app.js')}
</script>
`;
html = inlineImages(html);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log('Anteprima scritta in ' + out);
