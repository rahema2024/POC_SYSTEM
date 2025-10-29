// server.js (Full POC)
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const multer = require('multer');
const fs = require('fs');
const { google } = require('googleapis');
const { Storage } = require('@google-cloud/storage');
const fetch = require('node-fetch');
const Stripe = require('stripe');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: "public/uploads/" });

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = "Sheet1";
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const GCS_BUCKET = process.env.GCS_BUCKET;
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const stripe = STRIPE_KEY ? Stripe(STRIPE_KEY) : null;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// redirect root to storefront
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

// ========== Google Sheets init ==========
let sheetsClient;
async function initSheets() {
  // service account via GOOGLE_APPLICATION_CREDENTIALS_PATH
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS_PATH || './service-account.json';
  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
}
initSheets().catch(err => console.warn('Sheets init error', err.message));

// ========== Google Cloud Storage init (optional) ==========
let gcs;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_PATH && process.env.GCS_BUCKET) {
  gcs = new Storage({ keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS_PATH });
}

// helper: upload file to GCS (returns public URL)
async function uploadToGCS(localPath, destName) {
  if (!gcs || !GCS_BUCKET) return null;
  await gcs.bucket(GCS_BUCKET).upload(localPath, { destination: destName, public: true });
  const publicUrl = `https://storage.googleapis.com/${GCS_BUCKET}/${destName}`;
  return publicUrl;
}

// helper: append row to Google Sheet
async function appendSheetRow(values) {
  if (!sheetsClient) throw new Error('Sheets client not initialized');
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] }
  });
}

// ========== 1) Web order (checkout simulation) ==========
app.post('/api/web-order', upload.single('audio'), async (req, res) => {
  try {
    const { name, phone, address, items, total } = req.body; // items as JSON string or text
    let audioLocal = '';
    let audioUrl = '';
    if (req.file) {
      audioLocal = req.file.path;
      if (gcs) {
        const destName = `audios/${Date.now()}_${req.file.originalname || req.file.filename}`;
        audioUrl = await uploadToGCS(audioLocal, destName);
      } else {
        // serve local file path (public/uploads)
        audioUrl = `/uploads/${req.file.filename}`;
      }
    }

    // optionally: transcribe via OpenAI
    let transcript = '';
    if (audioLocal && OPENAI_KEY) {
      try {
        const fdata = fs.createReadStream(audioLocal);
        // call OpenAI transcription endpoint (multipart)
        const form = new (require('form-data'))();
        form.append('file', fdata);
        form.append('model', 'gpt-4o-transcribe'); // change if needed or use whisper-1
        // NOTE: actual endpoint name can differ; this is indicative. If using openai node SDK, change accordingly.
        const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${OPENAI_KEY}` },
          body: form
        });
        const jr = await r.json();
        transcript = jr.text || jr.transcription || '';
      } catch (e) {
        console.warn('transcription error', e.message);
      }
    }

    const created_at = new Date().toISOString();
    const status = 'New';
    const delivered_at = '';
    // row columns: created_at, client_name, phone, address, items, audio_url, transcript, status, driver, delivered_at
    await appendSheetRow([created_at, name, phone, address, items || '', audioUrl, transcript, status, '', delivered_at]);

    // Optionally create Stripe payment session (if using)
    if (stripe && total) {
      // Basic checkout session (server creates session and returns url)
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{ price_data: { currency: 'usd', product_data: { name: `Order by ${name}` }, unit_amount: Math.round(parseFloat(total) * 100) }, quantity: 1 }],
        mode: 'payment',
        success_url: `${req.protocol}://${req.get('host')}/?paid=1`,
        cancel_url: `${req.protocol}://${req.get('host')}/?paid=0`
      });
      return res.json({ ok: true, checkoutUrl: session.url });
    }

    res.json({ ok: true, message: 'Order received', audioUrl, transcript });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ========== 2) Twilio voice webhook (recording URL comes here) ==========
/*
  Configure Twilio to record calls and send recording via webhook to /api/twilio/voice
  Twilio POST fields include: RecordingUrl, RecordingSid, From (caller), To, etc.
*/
app.post('/api/twilio/voice', bodyParser.urlencoded({ extended: true }), async (req, res) => {
  try {
    // Twilio POST body (urlencoded)
    const { RecordingUrl, From, To, RecordingDuration } = req.body;
    // Twilio's RecordingUrl is a URL you can fetch (.wav/.mp3)
    const created_at = new Date().toISOString();
    const name = From || 'Unknown';
    const phone = From || '';
    const address = '';
    const items = 'Voice order';
    let audioUrl = '';
    // fetch recording and save locally
    if (RecordingUrl) {
      const fetchUrl = RecordingUrl.replace('.mp3', '.mp3'); // Twilio usually gives .wav or .mp3 link
      const localPath = `public/uploads/${Date.now()}_twilio.mp3`;
      const resp = await fetch(fetchUrl);
      const buffer = await resp.arrayBuffer();
      fs.writeFileSync(localPath, Buffer.from(buffer));
      if (gcs) {
        const destName = `audios/${Date.now()}_twilio.mp3`;
        audioUrl = await uploadToGCS(localPath, destName);
      } else {
        audioUrl = `/${localPath}`;
      }
    }

    // optional transcription using OpenAI
    let transcript = '';
    if (OPENAI_KEY && audioUrl) {
      try {
        const fdata = fs.createReadStream(path.join(__dirname, audioUrl.replace(/^\//,'')));
        const form = new (require('form-data'))();
        form.append('file', fdata);
        form.append('model', 'gpt-4o-transcribe');
        const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${OPENAI_KEY}` },
          body: form
        });
        const jr = await r.json();
        transcript = jr.text || '';
      } catch(e) { console.warn('twilio transcription failed', e.message); }
    }

    const status = 'New';
    const delivered_at = '';
    await appendSheetRow([created_at, name, phone, address, items, audioUrl, transcript, status, '', delivered_at]);

    // respond 200 to Twilio
    res.type('text/xml');
    // Return a simple TwiML response (you must set Twilio to webhook to this endpoint)
    res.send(`<Response><Say>تم استلام طلبك، سنقوم بالتواصل معك قريبا</Say></Response>`);
  } catch (err) {
    console.error('twilio webhook error', err);
    res.status(500).send('Error');
  }
});

// ========== 3) Driver confirmation endpoint (called by confirm.html) ==========
app.post('/api/update-order', async (req, res) => {
  try {
    const { rowIndex, status, driver } = req.body;
    if (!rowIndex) return res.status(400).json({ ok: false, error: 'rowIndex required (1-based row index in sheet)' });
    const deliveredAt = status === 'Delivered' ? new Date().toISOString() : '';
    const range = `${SHEET_NAME}!H${rowIndex}:J${rowIndex}`; // status, driver, delivered_at
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [[status, driver || '', deliveredAt]] }
    });
    res.json({ ok: true, message: 'Updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ========== 4) Admin API: fetch latest rows from sheet ==========
app.get('/api/admin/orders', async (req, res) => {
  try {
    const resp = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:J`
    });
    const rows = resp.data.values || [];
    res.json({ ok: true, rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
