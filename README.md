# ⚓ Chat di bordo

Una chat privata in stile WhatsApp per i ~2000 partecipanti di un evento in nave.
È un sito web: non c'è nessuna app da installare. Funziona da qualsiasi telefono
con il browser, anche quando l'unica connessione disponibile è il **singolo URL
sbloccato** dalla nave.

## Cosa fa

- **Accesso solo per gli iscritti**: ognuno entra con un codice personale di 6 caratteri.
- **📢 Annunci**: canale in cui scrivono solo gli organizzatori e che tutti leggono.
- **🚢 Tutti a bordo**: canale aperto a tutti.
- **Chat private 1 a 1**: si cerca una persona per nome tra i partecipanti.
- **Gruppi**: per esempio "Cabina 512" o "Gita Mykonos". Si possono aggiungere persone e uscire dal gruppo.
- Messaggi non letti, separatori per giorno e il conteggio nel titolo della scheda.
- Funziona in tema chiaro e scuro, su telefono e su computer, e si può aggiungere alla schermata Home.
- **Moderazione**: gli organizzatori possono cancellare messaggi, sospendere utenti e creare nuovi canali.

## Perché è fatto così (connessione della nave)

| Vincolo | Scelta |
|---|---|
| La nave sblocca solo gli URL richiesti | **Tutto** è servito dallo stesso dominio: niente CDN, Google Fonts o analytics. Basta far sbloccare un solo dominio (es. `chat.tuoevento.it`). |
| I proxy delle navi spesso bloccano i WebSocket | Il tempo reale usa il **long-polling HTTP** su HTTPS standard: richieste da massimo 25 secondi, sotto i timeout tipici dei proxy. |
| La banda satellitare è poca e condivisa da 2000 persone | Solo testo ed emoji (niente foto né video), risposte compresse con gzip. La pagina intera pesa circa 12 KB. |
| Tutti escono dallo stesso IP della nave | I limiti anti-abuso contano solo i codici sbagliati, non gli accessi corretti. |

Prova di carico fatta: **2000 utenti collegati insieme**, 30 messaggi nel canale
generale, **60.000 consegne su 60.000**, latenza mediana circa 0,2 s, circa 170 MB di RAM.

## Requisiti

- Node.js **22.13 o più recente**. Non ci sono dipendenze npm: il database è SQLite, già incluso in Node.

## Preparazione

### 1. Importa i partecipanti

Parti da un CSV, esportato per esempio dal gestionale WeRoad, con almeno la colonna `nome`
(oppure `nome` e `cognome`). Le colonne `email` e `admin` sono facoltative: con `admin = si` la persona diventa organizzatore.

```csv
nome;cognome;email;admin
Anna;Bianchi;anna@example.com;
Carla;Rossi;carla@weroad.it;si
```

```bash
npm run import -- partecipanti.csv codici.csv
```

Lo script genera `codici.csv` con il codice personale di ognuno. Si può rilanciare
più volte: chi è già stato importato mantiene il suo codice.

**Manda il codice a ogni partecipante prima della partenza**, per email o sul
badge. A bordo non avranno internet per riceverlo.

### 2. In alternativa: registrazione libera

Se non avete la lista dei partecipanti, avviate il server con un codice evento:

```bash
JOIN_CODE=CROCIERA2026 npm start
```

Chi conosce il codice evento si registra con nome e cognome e riceve il suo codice
personale. Potete comunicare il codice evento a bordo, per esempio su un cartello.
Le due modalità possono convivere.

### 3. Comandi utili

```bash
npm run admin -- add "Mario Rossi" --admin   # crea un utente (anche organizzatore)
npm run admin -- find rossi                  # ritrova il codice di qualcuno
npm run admin -- promote K7PQ2M              # rende organizzatore
npm run admin -- stats
```

## Messa online

Il server va pubblicato su internet **con HTTPS**, su un dominio vostro. Poi si
chiede alla nave di sbloccare **quel dominio**.

**Con Docker, su una VPS** (Hetzner, DigitalOcean, Aruba…). L'HTTPS si mette davanti, per esempio con Caddy:

```bash
docker build -t chat-nave .
docker run -d --restart=always -p 3000:3000 -v chat-data:/app/data \
  -e JOIN_CODE=CROCIERA2026 chat-nave
# import dei partecipanti dentro il container:
docker cp partecipanti.csv <container>:/app/
docker exec <container> node scripts/import.js partecipanti.csv codici.csv
docker cp <container>:/app/codici.csv .
```

**Su Render, Railway o Fly.io**: è un normale servizio Node (`npm start`). Serve un
**disco persistente** montato su `DATA_DIR`, altrimenti i messaggi si perdono a ogni riavvio.

Per 2000 persone basta una macchina piccola (1 vCPU, 1 GB di RAM). Deve restare
**un'unica istanza**: i messaggi in tempo reale passano dalla memoria del processo.

### Variabili d'ambiente

| Variabile | Default | Significato |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `DATA_DIR` | `./data` | Cartella del database `chat.db` (fatene un backup!) |
| `JOIN_CODE` | non impostata | Attiva la registrazione libera con questo codice evento |
| `SECURE_COOKIE` | `1` | Mettere `0` solo per le prove in locale senza HTTPS |

### Prima di partire: checklist

1. Chiedete alla nave di sbloccare il vostro dominio, per esempio `chat.tuoevento.it`.
   Il sito non usa nessun altro dominio.
2. Chiedete se il proxy della nave **chiude le richieste lunghe**. Il sito tiene
   aperte richieste fino a 25 secondi. Se le chiudono prima, la chat funziona lo
   stesso, ma con qualche secondo di ritardo.
3. Se possibile, provate il sito dalla rete della nave o da una connessione lenta.
4. Mandate i codici personali e il link a tutti **prima dell'imbarco**.

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
- `public/`: interfaccia web in JS puro, senza framework né build
- `scripts/`: import dei partecipanti e comandi di amministrazione
