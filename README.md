# 🚢 WeRoad Global Reunion · Cruise Edition

La chat privata, in stile WhatsApp, per i ~2000 partecipanti della Global Reunion in nave.
È un sito web: non c'è nessuna app da installare. Funziona da qualsiasi telefono
con il browser, anche quando l'unica connessione disponibile è il **singolo URL
sbloccato** dalla nave.

## Cosa fa

- **Registrazione semplice**: nome, cognome ed email. La prima volta ci si registra, le volte dopo si rientra con la stessa email e lo stesso cognome.
- **📢 Annunci**: canale in cui scrivono solo gli organizzatori e che tutti leggono.
- **🚢 Tutti a bordo**: canale aperto a tutti.
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

## Chi può entrare

Di default chiunque abbia il link può registrarsi con nome, cognome ed email.
Per limitare l'accesso ci sono due opzioni, combinabili:

- **Solo la lista partecipanti** (consigliato per l'evento): importate il CSV degli
  iscritti e avviate con `SOLO_ISCRITTI=1`. Entra solo chi usa l'email con cui si è
  iscritto al viaggio.
- **Codice evento**: con `JOIN_CODE=CROCIERA2026` chi si registra per la prima
  volta deve inserire anche il codice evento, comunicato per esempio su un cartello a bordo.

Per rientrare bastano email e cognome. È comodo, ma vuol dire che chi conosce
email e cognome di qualcun altro potrebbe entrare al suo posto. Per una chat
tra partecipanti di un evento è un compromesso ragionevole. Non usatela per
informazioni riservate.

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
| `SOLO_ISCRITTI` | non impostata | Con `1` entrano solo le email importate dalla lista |
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
