#!/usr/bin/env node
'use strict';
// Genera un'anteprima statica in un unico file HTML (server simulato nel browser).
//
//   node scripts/build-demo.js [output.html] [--shared]
//
// Serve solo per far provare grafica e funzionamento senza mettere online il server:
// i messaggi restano nel browser di chi la apre e gli altri partecipanti sono finti.
// Con --shared l'anteprima, pubblicata come artifact su claude.ai con la capability
// "db", diventa una chat vera tra le persone invitate (vedi demo/shared.js).

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const args = process.argv.slice(2);
const shared = args.includes('--shared');
const out = args.find((a) => !a.startsWith('--')) || path.join(root, 'demo', 'anteprima.html');
const organizers = read('organizzatori.txt').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const sharedScript = shared
  ? `<script>\nwindow.ORGANIZER_EMAILS = ${JSON.stringify(organizers)};\n${read('demo/shared.js')}\n</script>`
  : '';

const index = read('public/index.html');
const body = index.slice(index.indexOf('<body>') + 6, index.indexOf('<script src="/app.js')).trim();
const title = index.match(/<title>(.*?)<\/title>/)[1];

const banner = `<div class="demo-banner">Preview: messages and other participants are simulated and stay on this device only.</div>`;
const extraCss = `
.demo-banner { position: fixed; left: 50%; transform: translateX(-50%); bottom: 8px; z-index: 30; max-width: calc(100% - 32px);
  background: var(--ink); color: #fff; font-size: 12px; padding: 6px 12px; border-radius: 999px; text-align: center; pointer-events: none; opacity: .92; }
#login.hidden ~ .demo-banner { display: none; }
`;
// Le immagini vengono incorporate come data URI: l'anteprima è un unico file.
const dataUri = (file, type) => `data:${type};base64,${fs.readFileSync(path.join(root, 'public', file)).toString('base64')}`;
const IMAGES = {
  '/wordmark.png': dataUri('wordmark.png', 'image/png'),
  '/waves.jpg': dataUri('waves.jpg', 'image/jpeg'),
  '/anton.woff2': dataUri('anton.woff2', 'font/woff2'),
  '/wordmark-t.png': dataUri('wordmark-t.png', 'image/png'),
  '/waves-t.png': dataUri('waves-t.png', 'image/png'),
};
const inlineImages = (text) => text.replace(/\/(wordmark-t\.png|waves-t\.png|wordmark\.png|waves\.jpg|anton\.woff2)/g, (m) => IMAGES[m]);

let html = `<title>${title}</title>
<style>
${read('public/style.css')}
${extraCss}
</style>
${body}
${banner}
${sharedScript}
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
