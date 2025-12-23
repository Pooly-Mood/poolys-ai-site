require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs-extra");
const { OpenAI } = require("openai");
const pdfParse = require('pdf-parse');
const nodemailer = require("nodemailer");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 2025;
console.log(`Starting server.js (PORT=${PORT})`);

// Middleware
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

// Rate limiting
const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 requests per session
  message: "Troppi messaggi! Riprova fra 15 minuti.",
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api/chat", chatLimiter);

// OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Email transporter (Gmail example - use your service)
const transporter = nodemailer.createTransport({
  service: "outlook",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Verify transporter availability at startup and disable notifications if not available
let EMAIL_AVAILABLE = false;
transporter.verify()
  .then(() => {
    EMAIL_AVAILABLE = true;
    console.log('📧 Email transporter OK');
  })
  .catch((err) => {
    EMAIL_AVAILABLE = false;
    console.warn('⚠️ Email transporter not available:', err.message || err);
    console.warn('Disabilito le notifiche email finché la configurazione non verrà corretta.');
  });

// Keywords that trigger email notification
const TRIGGER_KEYWORDS = ["preventivo", "contatto", "contati", "persona", "contattami"];

// Memory storage
const MEMORY_FILE = path.join(__dirname, "..","data", "memory", "aiMemory.json");
// 🔹 CARICA CATALOGO: prova il PDF, poi fallback su TXT
async function loadCatalogData() {
  try {
    const pdfPath = path.join(__dirname, '..', 'data', 'catalogo-poolys-mood.pdf');
    const exists = await fs.pathExists(pdfPath);
    if (exists) {
      // Non parsifichiamo il PDF qui: riportiamo presenza del file.
      return 'CATALOGO: file PDF presente (data/catalogo-poolys-mood.pdf)';
    }
  } catch (err) {
    console.warn('Errore checking PDF catalogo:', err.message || err);
  }

  // Fallback su file di testo
  try {
    // Proviamo prima il file `catalogo.txt`, poi `espositori-vino.txt` come fallback storico
    const txtCandidates = ['catalogo.txt', 'espositori-vino.txt'];
    for (const fname of txtCandidates) {
      const txtPath = path.join(__dirname, '..', 'data', fname);
      const existsTxt = await fs.pathExists(txtPath);
      if (existsTxt) {
        // Leggiamo come Buffer per poter rilevare PDF salvati con estensione .txt
        const buf = await fs.readFile(txtPath);
        const header = buf.slice(0, 5).toString('utf8');
        // Se il file è in realtà un PDF (es. '%PDF-'), spostiamolo su catalogo-poolys-mood.pdf
        if (header.startsWith('%PDF')) {
          const pdfPath = path.join(__dirname, '..', 'data', 'catalogo-poolys-mood.pdf');
          await fs.writeFile(pdfPath, buf);
          console.log(`Rilevato PDF dentro data/${fname}; creato ${path.relative(__dirname + '/..', pdfPath)}`);
          return 'CATALOGO: file PDF presente (data/catalogo-poolys-mood.pdf)';
        }

        // Altrimenti torniamo il testo
        const txt = buf.toString('utf8');
        console.log(`Caricato catalogo testuale: data/${fname}`);
        return txt;
      } else {
        console.warn(`Catalogo testuale non trovato: data/${fname}`);
      }
    }
    console.warn('Nessun catalogo testuale trovato in data');
    return 'CATALOGO NON TROVATO';
  } catch (err) {
    console.warn('Errore leggendo catalogo testuale:', err.message || err);
    return 'CATALOGO NON TROVATO';
  }
}

// Chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId, clientId } = req.body;

    if (!message || !clientId) {
      return res.status(400).json({ error: 'Messaggio o clientId mancante' });
    }

    // Generate new session if needed
    const currentSessionId = sessionId || uuidv4();

    // Load memory
    const memory = await loadMemory();
    if (!memory.sessions) memory.sessions = {};
    if (!memory.sessions[currentSessionId]) {
      memory.sessions[currentSessionId] = {
        clientId,
        messages: [],
        created: new Date().toISOString(),
      };
    }

    // Add user message to memory
    memory.sessions[currentSessionId].messages.push({
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    });

    // Check for trigger keywords
    const hasTrigger = TRIGGER_KEYWORDS.some((keyword) =>
      message.toLowerCase().includes(keyword.toLowerCase())
    );

    // Load catalog data
    const catalogoData = await loadCatalogData();

    // Se la richiesta sembra riguardare il catalogo, rispondiamo localmente senza chiamare l'AI
    const CATALOG_KEYWORDS = ['catalogo', 'modello', 'modelli', 'espositore', "che modelli", 'scheda', 'dettagli'];
    const messageLower = message.toLowerCase();
    const isCatalogRequest = CATALOG_KEYWORDS.some(k => messageLower.includes(k));
    if (isCatalogRequest) {
      try {
        const catalogText = await ensureCatalogText();
        if (!catalogText) {
          const replyLocal = 'Mi dispiace, non ho il catalogo testuale disponibile al momento.';
          memory.sessions[currentSessionId].messages.push({ role: 'assistant', content: replyLocal, timestamp: new Date().toISOString() });
          await saveMemory(memory);
          return res.json({ reply: replyLocal, sessionId: currentSessionId });
        }

        const results = searchCatalog(message, catalogText, 5);
        let replyLocal;
        if (!results.length) {
          replyLocal = 'Non ho trovato risultati nel catalogo per la tua richiesta. Prova con parole chiave diverse (es. modello, misure, materiale).';
        } else {
          replyLocal = `Ho trovato ${results.length} risultati nel catalogo:\n` + results.map((r, i) => `${i+1}. ${r.snippet}`).join('\n');
        }

        memory.sessions[currentSessionId].messages.push({ role: 'assistant', content: replyLocal, timestamp: new Date().toISOString() });
        await saveMemory(memory);
        return res.json({ reply: replyLocal, sessionId: currentSessionId });
      } catch (err) {
        console.error('Errore ricerca catalogo locale:', err);
      }
    }

    const messages = [
      {
        role: 'system',
        content: `
        [PROMPT TITLE]
PoolyAI – Assistente Ufficiale Pooly’s Mood

[DESCRIPTION]
Assistente virtuale per gestire richieste relative al catalogo Pooly’s Mood.
Fornisce tutti 8 nomi prodotti, misure, capacità e materiali esatti.

[STYLE]
• Caldo, diretto, umano
• Parlare in terza persona
• Guida l’utente passo passo se necessario

[MEMORY]
• Ogni chat visibile come nuova
• Ricorda internamente le informazioni rilevanti dello stesso IP
• Non mescolare dati di IP diversi
• Memoria conversazioni passate invisibile all’utente

[SCOPE]
• Rispondere SOLO con i valori esatti del catalogo ufficiale Pooly’s Mood
• Non inventare informazioni
• Non includere dati estranei
• Prova aiutare il cliente se : la parole scritta malle ,richiete piu info ,non e chiara, ecc
• Se l’utente chiede soggetti non Pooly’s Mood:
  "Chiedo scusa! Mi occupo solo di espositori Pooly’s Mood! 🍷"
• NON rispondere mai con :" Ho trovato .. risultati nel catalogo " formula una risposta formato umano


[OUTPUT RULES]
• NON rispondere mai con:" Ho trovato .. risultati nel catalogo " formula una risposta formato umano
• Existe  un catalogo ufficiale Pooly’s Mood, rispondi SOLO con i dati esatti del catalogo
• Rispondi SOLO con informazioni presenti nel catalogo ufficiale Pooly’s Mood
• Misure precise (cm)
• Capacità bottiglie
• Materiali,controlare la coerenza con il catalogo ufficiale e ai memory.json
• Lista nomi prodotti numerata se richiesto
• Nessuna interpretazione o aggiunta
• Modelli , esempi , tipi/tipo ,varianti intendono [CATALOG REFERENCE]
• QUALSIASI MATERIALE DIVERSO DA LEGNO NATURARE E ACCIAIO INOX È DA CONSIDERARE ERRORE GRAVE.
• E VIETATO , DEDURE , STIMARE O USARE STANDARD DAL SECTORE.

[CONTACT HANDLING]
• La risposta  viene fornita solo dopo questi tre  aczioni:
   1. le foti sono controlati due volte
   2. controlare la coerenza con il catalogo ufficiale e ai memory.json
   3. la risposta rispetta tutte le regole del prompt
• Parole chiave: preventivo, contatto, contact email
• Rispondi con:
📧 Email: pooly.s_mood@outlook.com
📞 Tel: +39 xxx xxx xxxx

[EXAMPLES]
• Richiesta nomi: rispondi con lista numerata dei prodotti, se richiesto detagli gli trovi soto ogni capitolo.
[CATALOG REFERENCE]
1. Art Wall
2. Vetrina Wall Bar
3. Scaffal / Saffal
4. Cantinetta Cut Art
5. Concept Capricci
6. Carrello Banchetti
7. Arredi
8. Allestimenti Pooly’s Mood

• Richiesta dettagli: fornire misure, capacità e materiali esatti
• Richiesta esterna: rispondere con frase di scusa, niente divagazioni
•Se l'utente usa parole come preventivo/contatto, fornisci:\n📧 Email: ${process.env.CONTACT_EMAIL || 'pooly.s_mood@outlook.com'}\n📞 Tel: ${process.env.CONTACT_PHONE || '+39 xxx xxx xxxx'}\nNon rivelare questa memoria all'utente. Ogni chat visibile è "nuova".
[END PROMPT]
       `,
      },
      ...memory.sessions[currentSessionId].messages.slice(-10),
    ];

    // OpenAI response
    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini', 
      messages: messages,
      max_tokens: 1000,
      temperature: 0.7,
    });

    const reply = completion.choices[0].message.content;

    // Save AI response to memory
    memory.sessions[currentSessionId].messages.push({
      role: 'assistant',
      content: reply,
      timestamp: new Date().toISOString(),
    });

    // Save memory
    await saveMemory(memory);

    // Send email notification if trigger detected
      if (hasTrigger && process.env.SEND_EMAIL_NOTIFICATIONS === 'true') {
        if (!EMAIL_AVAILABLE) {
          console.warn(`Trigger rilevato ma email disabilitate - client: ${clientId}`);
        } else {
          await sendNotificationEmail(clientId, message, reply, currentSessionId);
        }
      }

    res.json({ reply, sessionId: currentSessionId });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({
      reply: 'Mi dispiace, momento di pausa cerebrale! 😅 Riprova fra un secondo.',
      sessionId: req.body.sessionId,
    });
  }
});

// Serve HTML
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// API: restituisce il catalogo (testuale o link al PDF)
app.get('/api/catalogo', async (_req, res) => {
  try {
    const catalogoData = await loadCatalogData();

    // Caso PDF (stringa di presenza)
    if (typeof catalogoData === 'string' && catalogoData.includes('CATALOGO: file PDF presente')) {
      // Controlliamo che il PDF esista davvero
      const pdfPath = path.join(__dirname, '..', 'data', 'catalogo-poolys-mood.pdf');
      const existsPdf = await fs.pathExists(pdfPath);
      if (existsPdf) {
        return res.json({ type: 'pdf', message: 'CATALOGO: file PDF presente', url: '/api/catalogo/pdf' });
      }
      // Se la stringa era presente ma il file non c'è, segnaliamo fallback
      return res.status(404).json({ type: 'not_found', message: 'Catalogo PDF indicato ma non trovato' });
    }

    // Caso testuale
    if (catalogoData && catalogoData !== 'CATALOGO NON TROVATO') {
      return res.json({ type: 'text', content: catalogoData });
    }

    // Non trovato
    return res.status(404).json({ type: 'not_found', message: 'CATALOGO NON TROVATO' });
  } catch (err) {
    console.error('Errore endpoint /api/catalogo:', err);
    res.status(500).json({ error: 'Errore interno caricamento catalogo' });
  }
});

// API: scarica il PDF del catalogo se presente
app.get('/api/catalogo/pdf', async (_req, res) => {
  try {
    const pdfPath = path.join(__dirname, '..', 'data', 'catalogo-poolys-mood.pdf');
    const existsPdf = await fs.pathExists(pdfPath);
    if (!existsPdf) return res.status(404).send('PDF catalogo non trovato');
    return res.sendFile(pdfPath);
  } catch (err) {
    console.error('Errore endpoint /api/catalogo/pdf:', err);
    res.status(500).send('Errore interno');
  }
});

// API: ricerca nel catalogo testuale (estratto da PDF se necessario)
app.get('/api/catalogo/search', async (req, res) => {
  try {
    const q = req.query.q || req.query.qs || req.query.query;
    if (!q) return res.status(400).json({ error: 'query param "q" mancante' });

    const catalogText = await ensureCatalogText();
    if (!catalogText) return res.status(404).json({ error: 'Catalogo testuale non disponibile' });

    const results = searchCatalog(q, catalogText, 20);
    res.json({ query: q, count: results.length, results });
  } catch (err) {
    console.error('Errore /api/catalogo/search:', err);
    res.status(500).json({ error: 'Errore interno' });
  }
});

// API: forza l'estrazione del catalogo testuale dal PDF e salva in data/catalogo.txt
app.get('/api/catalogo/generate-text', async (_req, res) => {
  try {
    const pdfPath = path.join(__dirname, '..', 'data', 'catalogo-poolys-mood.pdf');
    if (!await fs.pathExists(pdfPath)) return res.status(404).json({ error: 'Catalogo PDF non trovato' });

    const buf = await fs.readFile(pdfPath);
    // Use a compatibility layer for `pdf-parse` which may expose different API shapes
    let parsed = null;
    if (pdfParse && typeof pdfParse === 'function') {
      parsed = await pdfParse(buf);
    } else if (pdfParse && pdfParse.PDFParse) {
      const parser = new pdfParse.PDFParse(new Uint8Array(buf));
      await parser.load();
      const data = await parser.getText();
      parsed = { text: (data.pages || []).map(p => p.text).join('\n\n') };
    } else if (pdfParse && pdfParse.default && typeof pdfParse.default === 'function') {
      parsed = await pdfParse.default(buf);
    } else {
      throw new Error('pdf-parse parse function non disponibile');
    }
    let text = (parsed.text || '').replace(/\r/g, '\n');

    // Pulizia semplice: rimuovi spazi multipli, collapse di linee vuote multiple
    text = text.replace(/\t/g, ' ');
    text = text.replace(/ +/g, ' ');
    text = text.replace(/\n[ \t\n\r]+/g, '\n\n');
    text = text.split('\n').map(l => l.trim()).filter(Boolean).join('\n');

    const txtPath = path.join(__dirname, '..', 'data', 'catalogo.txt');
    await fs.writeFile(txtPath, text, 'utf8');
    CATALOG_TEXT_CACHE = text;

    console.log('Catalogo testuale generato da PDF: data/catalogo.txt');
    res.json({ message: 'Catalogo testuale generato', path: 'data/catalogo.txt', length: text.length });
  } catch (err) {
    console.error('Errore generazione catalogo testuale:', err);
    res.status(500).json({ error: 'Errore interno generazione catalogo' });
  }
});

// API: restituisce il catalogo testuale (download)
app.get('/api/catalogo/txt', async (_req, res) => {
  try {
    const txtPath = path.join(__dirname, '..', 'data', 'catalogo.txt');
    if (!await fs.pathExists(txtPath)) return res.status(404).send('Catalogo testuale non trovato');
    return res.sendFile(txtPath);
  } catch (err) {
    console.error('Errore endpoint /api/catalogo/txt:', err);
    res.status(500).send('Errore interno');
  }
});

// Memory functions
async function loadMemory() {
  try {
    return await fs.readJson(MEMORY_FILE);
  } catch {
    return { sessions: {} };
  }
}

// Catalog text extraction & search helpers
let CATALOG_TEXT_CACHE = null;
async function ensureCatalogText() {
  if (CATALOG_TEXT_CACHE) return CATALOG_TEXT_CACHE;

  // Prefer text file
  const txtPath = path.join(__dirname, '..', 'data', 'catalogo.txt');
  if (await fs.pathExists(txtPath)) {
    CATALOG_TEXT_CACHE = await fs.readFile(txtPath, 'utf8');
    return CATALOG_TEXT_CACHE;
  }

  // Else try PDF
  const pdfPath = path.join(__dirname, '..', 'data', 'catalogo-poolys-mood.pdf');
  if (await fs.pathExists(pdfPath)) {
    try {
      const buf = await fs.readFile(pdfPath);
      let parsed = null;
      if (pdfParse && typeof pdfParse === 'function') {
        parsed = await pdfParse(buf);
      } else if (pdfParse && pdfParse.PDFParse) {
        const parser = new pdfParse.PDFParse(new Uint8Array(buf));
        await parser.load();
        const data = await parser.getText();
        parsed = { text: (data.pages || []).map(p => p.text).join('\n\n') };
      } else if (pdfParse && pdfParse.default && typeof pdfParse.default === 'function') {
        parsed = await pdfParse.default(buf);
      } else {
        throw new Error('pdf-parse parse function non disponibile');
      }

      const text = (parsed.text || '').replace(/\r/g, '\n');
      // Persist a text cache for quicker subsequent searches
      await fs.writeFile(txtPath, text, 'utf8');
      CATALOG_TEXT_CACHE = text;
      console.log('Estratto testo da PDF e salvato in data/catalogo.txt');
      return CATALOG_TEXT_CACHE;
    } catch (err) {
      console.error('Errore estraendo testo dal PDF:', err.message || err);
      return null;
    }
  }

  return null;
}

function normalize(s) {
  return s.normalize ? s.normalize('NFKD').toLowerCase() : (s || '').toLowerCase();
}

function searchCatalog(query, catalogText, maxResults = 5) {
  const q = normalize(query).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3);
  const lines = catalogText.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const results = [];

  if (!q.length) {
    // return the first few non-empty lines as sample
    for (let i = 0; i < Math.min(maxResults, lines.length); i++) {
      results.push({ snippet: lines[i].slice(0, 240) });
    }
    return results;
  }

  for (const line of lines) {
    const nline = normalize(line);
    // match if ALL tokens are present (AND), or any if none
    const hasAll = q.every(tok => nline.includes(tok));
    if (hasAll) {
      results.push({ snippet: line.replace(/\s+/g, ' ').slice(0, 240) });
      if (results.length >= maxResults) break;
    }
  }

  // fallback: search any token OR-wise
  if (!results.length) {
    for (const line of lines) {
      const nline = normalize(line);
      if (q.some(tok => nline.includes(tok))) {
        results.push({ snippet: line.replace(/\s+/g, ' ').slice(0, 240) });
        if (results.length >= maxResults) break;
      }
    }
  }

  return results;
}

async function saveMemory(memory) {
  await fs.ensureDir(path.dirname(MEMORY_FILE));
  await fs.writeJson(MEMORY_FILE, memory, { spaces: 2 });
}

// Email notification
async function sendNotificationEmail(clientId, userMsg, aiReply, sessionId) {
  try {
    if (!EMAIL_AVAILABLE) {
      console.warn('sendNotificationEmail chiamata ma transporter non disponibile - skip');
      return;
    }
    const conversation = `
Nuova conversazione triggerata da ${clientId} (Session: ${sessionId})

CLIENT: ${userMsg}
POOLYAI: ${aiReply}

---
Log completo disponibile in memory/aiMemory.json
    `.trim();

    await transporter.sendMail({
      from: `"PoolyAI Notifications" <${process.env.EMAIL_USER}>`,
      to: process.env.NOTIFY_EMAIL,
      subject: `🔔 PoolyAI - Nuovo ${TRIGGER_KEYWORDS.find(k => userMsg.toLowerCase().includes(k.toLowerCase())) || "contatto"} da ${clientId}`,
      text: conversation,
    });

    console.log(`📧 Notifica email inviata per client ${clientId}`);
  } catch (error) {
    console.error("Email notification error:", error);
  }
}

console.log('Calling app.listen...');
app.listen(PORT, () => {
  console.log(`🚀 Pooly\'s Mood Chat server running on http://localhost:${PORT}`);
  console.log(`📝 Memory file: ${MEMORY_FILE}`);
  console.log(`📧 Email notifications: ${process.env.SEND_EMAIL_NOTIFICATIONS === "true" ? "ON" : "OFF"}`);
  console.log('OPENAI_API_KEY' : proces.env.OPENAI_API_KEY? 'PRESENTE' : 'MANCANTE');
});
