# Pooly's Mood — PoolyAI

Pooly's Mood è un progetto per un assistente conversazionale leggero (PoolyAI) che aiuta a presentare i prodotti e rispondere a domande dai visitatori del sito.

Caratteristiche principali:
- Interfaccia chat integrata (pulsante "PoolyAI") con apertura/chiusura dal basso
- Memoria locale invisibile all'utente (`memory/aiMemory.json`)
- Endpoint backend: `/api/chat` per conversazioni, `/api/catalogo` e `/api/catalogo/search` per ricerca locale del catalogo
- Estrazione testo da PDF e ricerca testuale sul catalogo

Struttura del progetto (rilevante):

```
PoolysMood/
├── public/             # Frontend (chat widget + assets)
├── server/             # Backend Express (API e logica AI)
├── memory/             # Memoria locale (aiMemory.json)
├── data/               # Catalogo PDF / txt
├── package.json        # Dipendenze e script
└── README.md
```

Setup rapido 🔧

1. Installa dipendenze:
	```powershell
	npm install
	```
2. Crea un file `.env` con le variabili necessarie (esempio):
	```text
	OPENAI_API_KEY=sk-...
	PORT=2025
	SEND_EMAIL_NOTIFICATIONS=false
	```
3. Avvia il server:
	```powershell
	npm start
	```

API & comandi utili 📡
- `GET /api/catalogo` — informazioni su presenza del catalogo (testo o PDF)
- `GET /api/catalogo/pdf` — scarica PDF del catalogo (se presente)
- `GET /api/catalogo/generate-text` — estrae testo dal PDF e salva in `data/catalogo.txt`
- `GET /api/catalogo/txt` — scarica il file di testo del catalogo
- `GET /api/catalogo/search?q=...` — ricerca testuale nel catalogo
- `POST /api/chat` — invia messaggi alla AI (vedi `server/server.js` per dettagli)

Note e consigli 📝
- Per la posta (nodemailer) è possibile disabilitare le notifiche settando `SEND_EMAIL_NOTIFICATIONS=false` se non si dispone di credenziali SMTP funzionanti.
- Il file `memory/aiMemory.json` contiene conversazioni salvate e può essere editato o ripristinato secondo necessità.

Se vuoi, posso aggiungere una sezione con esempi pratici di chiamate `curl` o integrare una breve guida di deploy su GitHub Pages / Vercel.

---
Creato per Pooly's Mood — PoolyAI
