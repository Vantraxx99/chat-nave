# 🚢 WeRoad Global Reunion · Cruise Edition

L'app è in inglese, per i partecipanti internazionali. La chat privata, in stile WhatsApp, per i ~2000 partecipanti della Global Reunion in nave.
È un sito web: non c'è nessuna app da installare. Funziona da qualsiasi telefono
con il browser, anche quando l'unica connessione disponibile è il **singolo URL
sbloccato** dalla nave.

## Cosa fa

- **Registrazione semplice e protetta**: la prima volta nome, cognome, email e una password scelta da sé; le volte dopo bastano email e password.
- **📢 Annunci**: canale in cui scrivono solo gli organizzatori e che tutti leggono.
- Non c'è un canale generale: chi vuole chattare in gruppo crea il suo gruppo. Gli organizzatori possono comunque aprire canali per tutti dal menu "Nuova chat".
- **Chat private 1 a 1**: si cerca una persona per nome tra i partecipanti. Le email non sono mai visibili agli altri.
- **Gruppi**: per esempio "Cabina 512" o "Gita Mykonos". Si possono aggiungere persone e uscire dal gruppo.
- Messaggi non letti, separatori per giorno e il conteggio nel titolo della scheda.
- Grafica dell'evento (logo, onde e colori della Global Reunion), tema chiaro e scuro, telefono e computer. Si può aggiungere alla schermata Home.
- **Moderazione**: gli organizzatori possono cancellare messaggi, sospendere utenti e creare nuovi canali.

## Perché è fatto così (connessione della nave)

| Vincolo | Scelta |
|---|---|
| La nave sblocca solo gli URL richiesti | **Tutto** è servito dallo stesso dominio: niente CDN, Google Fonts o analytics. Basta far sbloccare un solo dominio (es. `chat.tuoevento.it`). |
| I proxy delle navi spesso bloccano i WebSocket | Il tempo reale usa il **long-polling HTTP** su HTTPS standard: richieste da massimo 25 secondi, sotto i timeout tipici dei proxy. |
| La banda satellitare è poca e condivisa da migliaia di persone | Solo testo ed emoji (niente foto né video), risposte compresse con gzip. Il codice pesa circa 12 KB, le immagini circa 60 KB e restano in cache sul telefono per una settimana. |
| Tutti escono dallo stesso IP della nave | I limiti anti-abuso contano solo i tentativi sbagliati, non gli accessi corretti. |

Prova di carico fatta: **3000 utenti collegati insieme**, 120 messaggi nel canale
generale a 10 messaggi al secondo: **360.000 consegne su 360.000**, consegna entro
1 secondo, circa 40% di un core e 140 MB di RAM.

## Costi e capacità

Il carico del server dipende quasi solo da quante persone sono collegate, non da
quanto scrivono. Dopo aver ricevuto messaggi il telefono aspetta un secondo prima
di chiedere i successivi, così i messaggi arrivati in quel secondo arrivano in
un'unica risposta.

| Piano Render | Prezzo | Risorse | Per 2000–3000 persone |
|---|---|---|---|
| Free | 0 $ | 512 MB, 0,1 CPU | Solo prove: si addormenta e perde i messaggi |
| Starter | 7 $/mese | 512 MB, 0,5 CPU | Prove con decine di persone; al limite con tutti online |
| **Standard** | **25 $/mese** | **2 GB, 1 CPU** | **Consigliato per l'evento**, con buon margine |

In più servono:
- **Disco persistente**: 0,25 $ per GB al mese. 1 GB basta e avanza.
- **Traffico**: si pagano 0,15 $ per GB oltre la quota inclusa. Per un evento di qualche giorno si stimano 10–25 GB, quindi pochi dollari.

I piani si pagano al secondo: se tenete il servizio acceso solo per le settimane
dell'evento, pagate solo quelle. Prezzi aggiornati a ottobre 2026: verificateli su
render.com/pricing.

Il vero collo di bottiglia sarà quasi certamente la connessione satellitare della
nave, non il server.

## Mettere l'app sulla Home

Nell'app c'è una guida passo passo per iPhone (Safari) e Android (Chrome). Si apre dal link sotto
il modulo di accesso, dal riquadro in cima alla lista (finché la chat non è sulla Home) e dal
menu ⋮. Su Android, quando Chrome lo permette, c'è direttamente il pulsante "Installa".

## Notifiche

- **Con la chat aperta**: suono (generato dall'app, nessun file da scaricare) e vibrazione
  quando arriva un messaggio in un'altra chat; un suono diverso per gli Annunci. Si regolano dal
  menu ⋮ → "Notifiche, suono e vibrazione". Su iPhone il browser non permette la vibrazione.
- **Ad app chiusa (push)**: ognuno le attiva dal riquadro in cima alla lista o dal menu.
  - **iPhone**: solo con iOS 16.4 o più recente, e solo se la chat è stata aggiunta alla schermata Home.
  - **Chi ha la chat aperta e in primo piano** non riceve il push, ma solo suono e vibrazione.
  - **A bordo**: le push passano dai server di Apple e Google, quindi la nave deve sbloccare
    anche `*.push.apple.com` (iPhone) e `fcm.googleapis.com` e `mtalk.google.com` (Android).
    Se non li sbloccano, le push non arrivano ma tutto il resto funziona.
- **Chiavi delle notifiche (VAPID)**: si generano da sole e vengono salvate in `DATA_DIR/vapid.json`.
  Si possono anche fissare con `VAPID_PUBLIC_KEY` e `VAPID_PRIVATE_KEY`; senza un disco persistente,
  a ogni riavvio bisogna riattivare le notifiche.

## Chi può entrare

Possono registrarsi **solo i partecipanti della Global Reunion**: le email delle
prenotazioni e dei check-in Team e Staff (1529 persone). Nel repository non ci sono
le email in chiaro, ma solo le loro impronte SHA-256 nel file `partecipanti.sha256`:
basta per riconoscere chi si registra senza rendere leggibile l'elenco.

- **Chi ha prenotato con un'altra email** non riesce a registrarsi. Gli organizzatori
  la abilitano dal menu ⋮ → "Abilita un'email".
- **Per aggiornare l'elenco** (nuove prenotazioni) esportate i fogli in CSV e lanciate
  `node scripts/allowlist.js prenotazioni.csv checkin-team.csv checkin-staff.csv`,
  passando sempre tutti gli elenchi insieme.
- `SOLO_ISCRITTI=0` riapre la registrazione a chiunque abbia il link.
- `JOIN_CODE=...` chiede anche un codice evento ai nuovi iscritti.

Ogni partecipante sceglie una password al primo accesso (salvata cifrata con scrypt),
così nessuno può entrare e scrivere al posto di un altro. Chi si era registrato prima
delle password ne sceglie una appena apre l'app. Dopo 10 password sbagliate di fila
l'account si blocca per 15 minuti. Password dimenticata: un organizzatore apre il
profilo della persona → **Reset password**; al prossimo accesso la persona ne sceglie
una nuova confermando il cognome. Resta una chat per un evento: non usatela per
informazioni riservate.

### Codice di verifica via email

Con l'invio email attivo, alla prima registrazione arriva un codice di 6 cifre
all'indirizzo indicato: l'account nasce solo dopo averlo inserito, quindi nessuno può
registrarsi con l'email di un altro. Conviene far iscrivere tutti **prima di salire a
bordo**, quando hanno ancora internet.

Serve un servizio di invio email; su Render (Environment) impostate:

- `BREVO_API_KEY` (Brevo) **oppure** `RESEND_API_KEY` (Resend)
- `MAIL_FROM`, il mittente, es. `Global Reunion <chat@vostrodominio.it>`: deve essere un
  indirizzo/dominio verificato sul servizio scelto.

Senza queste variabili il codice non viene chiesto (comodo per le prove).
A bordo, se qualcuno dimentica la password, un organizzatore apre il suo profilo →
**Reset password** e riceve un codice da dargli a voce (vale 48 ore): con quello la
persona sceglie una nuova password anche senza email.
Un codice vale 15 minuti e 5 tentativi; se ne può chiedere uno al minuto, 5 all'ora.

### Importare la lista partecipanti

CSV con le colonne `email` e `nome` (oppure `nome` e `cognome`). La colonna
`admin` è facoltativa: con `si` la persona diventa organizzatore. Il separatore
può essere `;` o `,`.

```csv
nome;cognome;email;admin
Anna;Bianchi;anna@example.com;
Carla;Rossi;carla@weroad.it;si
```

```bash
npm run import -- partecipanti.csv
```

Si può rilanciare quando la lista cambia: chi c'è già non viene duplicato. Il nome
mostrato in chat è quello della lista.

### Organizzatori

Le email nel file `organizzatori.txt` (una per riga) diventano organizzatori
appena entrano in chat. Oggi ci sono Filippo Roca e Sandro Drovandi. Si possono
aggiungere altre email anche con la variabile `ADMIN_EMAILS` (separate da
virgola), con la colonna `admin` del CSV oppure con i comandi:

```bash
npm run admin -- add "Mario Rossi" mario@email.it --admin
npm run admin -- promote mario@email.it
npm run admin -- unban mario@email.it
npm run admin -- find rossi
npm run admin -- stats
```

## Provarla subito

- **Anteprima statica**: `node scripts/build-demo.js` genera `demo/anteprima.html`, un file
  unico che funziona senza server. Gli altri partecipanti e i messaggi sono simulati.
- **Prova condivisa su claude.ai**: con `node scripts/build-demo.js out.html --shared`
  l'anteprima, pubblicata come artifact con l'archivio condiviso (`db`), diventa una chat
  vera tra le persone invitate alla pagina come Editor. Vale solo per le prove: i controlli
  sono fatti nel browser, quindi chi ha accesso può leggere anche le chat private.
- **In locale**: `npm run dev`, poi apri http://localhost:3000. Requisito: Node.js **22.13 o più recente**.
  Non ci sono dipendenze npm: il database è SQLite, già incluso in Node.

## Messa online

Il server va pubblicato su internet **con HTTPS**, su un dominio vostro. Poi si
chiede alla nave di sbloccare **quel dominio**. Deve girare **un'unica istanza**,
perché i messaggi in tempo reale passano dalla memoria del processo. Per 2000
persone basta una macchina piccola: 1 vCPU e 1 GB di RAM.

### Render (il più semplice, per le prove)

1. Create un account su [render.com](https://render.com) e collegate GitHub.
2. **New → Blueprint**, scegliete questo repository e il branch. Render legge `render.yaml`.
3. Alla richiesta di `ADMIN_EMAILS` potete lasciare vuoto: gli organizzatori sono già in `organizzatori.txt`.
4. Dopo un paio di minuti avete un indirizzo `https://global-reunion-chat-xxxx.onrender.com`.

Limiti del piano **free**:
- Se il sito resta inutilizzato per 15 minuti, si addormenta e la prima apertura successiva impiega circa un minuto.
- **I messaggi si cancellano a ogni riavvio.**

Per l'evento passate al piano Standard (1 CPU, 2 GB) e aggiungete un **Disk**
montato su `/opt/render/project/src/data`. Collegate anche il vostro dominio dalle
impostazioni del servizio.

### Docker su una VPS

Funziona su Hetzner, DigitalOcean, Aruba e simili. L'HTTPS si mette davanti, per esempio con Caddy.

```bash
docker build -t chat-nave .
docker run -d --restart=always -p 3000:3000 -v chat-data:/app/data \
  -e SOLO_ISCRITTI=1 -e ADMIN_EMAILS=tu@weroad.it chat-nave
docker cp partecipanti.csv <container>:/app/
docker exec <container> node scripts/import.js partecipanti.csv
```

### Variabili d'ambiente

| Variabile | Default | Significato |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `DATA_DIR` | `./data` | Cartella del database `chat.db` (fatene un backup!) |
| `SOLO_ISCRITTI` | automatico | Attivo se esiste `partecipanti.sha256`; `0` apre a tutti, `1` lo forza |
| `JOIN_CODE` | non impostata | Codice evento richiesto ai nuovi iscritti |
| `ADMIN_EMAILS` | non impostata | Altri organizzatori oltre a `organizzatori.txt`, separati da virgola |
| `SECURE_COOKIE` | `1` | Mettere `0` solo per le prove in locale senza HTTPS |

### Prima di partire: checklist

1. Chiedete alla nave di sbloccare il vostro dominio, per esempio `chat.tuoevento.it`.
   Il sito non usa nessun altro dominio.
2. Chiedete se il proxy della nave **chiude le richieste lunghe**. Il sito tiene
   aperte richieste fino a 25 secondi. Se le chiudono prima, la chat funziona lo
   stesso, ma con qualche secondo di ritardo.
3. Se possibile, provate il sito dalla rete della nave o da una connessione lenta.
4. Mandate il link a tutti prima dell'imbarco. Possono anche registrarsi da casa.

### Alternativa senza internet

Se la nave permette di collegare un computer alla sua rete Wi-Fi interna, lo stesso
server può girare su un portatile a bordo (`npm start`). I partecipanti lo
raggiungono all'indirizzo locale e la connessione satellitare non serve più. In
questo caso usate `SECURE_COOKIE=0` se non c'è HTTPS.

## Sviluppo

```bash
npm run dev   # http://localhost:3000, senza cookie Secure
npm test
```

Struttura:

- `src/server.js`: API HTTP, long-polling e file statici
- `src/db.js`: schema SQLite
- `src/identity.js`: email, nomi e controllo del cognome
- `public/`: interfaccia web in JS puro, senza framework né build
- `scripts/`: import dei partecipanti, comandi di amministrazione, anteprima
- `demo/demo.js`: server simulato usato solo dall'anteprima
