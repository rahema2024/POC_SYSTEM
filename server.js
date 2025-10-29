const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const multer = require('multer');
const fs = require('fs');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
const upload = multer({ dest: "public/uploads/" });

const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = "Sheet1";
const OPENAI_KEY = process.env.OPENAI_API_KEY;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

let sheetsClient;
async function initSheets() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      client_email: process.env.GOOGLE_SERVICE_EMAIL
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  sheetsClient = google.sheets({ version: "v4", auth });
}
initSheets().catch(e => console.error("Sheet init error", e));

async function appendSheetRow(values) {
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] }
  });
}

app.post("/api/web-order", upload.single("audio"), async (req, res) => {
  try {
    const { name, phone, address, items, total } = req.body;

    let audioUrl = "";
    if (req.file) {
      audioUrl = `/uploads/${req.file.filename}`;
    }

    const created_at = new Date().toISOString();
    const status = 'New';
    const transcript = ""; 

    await appendSheetRow([created_at, name, phone, address, items || '', audioUrl, transcript, status, '', '']);

    res.json({ ok: true, message: 'Order received', audioUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/update-order', async (req, res) => {
  try {
    const { rowIndex, status, driver } = req.body;
    if (!rowIndex) return res.status(400).json({ ok: false, error: 'rowIndex required' });

    const deliveredAt = status === 'Delivered' ? new Date().toISOString() : '';
    const range = `${SHEET_NAME}!H${rowIndex}:J${rowIndex}`;

    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [[status, driver || '', deliveredAt]] }
    });

    res.json({ ok: true, message: 'Order updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

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

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
