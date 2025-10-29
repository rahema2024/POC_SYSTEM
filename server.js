const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const multer = require('multer');
const fs = require('fs');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// node-fetch (ESM) loader
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const upload = multer({ dest: "public/uploads/" });
const PORT = process.env.PORT || 3000;

// ======= ENV =======
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_ORDERS = 'Orders';          // ستُنشأ تلقائياً إذا غير موجودة
const SHEET_CUSTOMERS = 'Customers';     // موجودة عندك (Sheet1 باسم Customers)
const SHEET_DRIVERS = 'Drivers';         // موجودة عندك (Sheet2 باسم drivers/Drivers)
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const GOOGLE_SERVICE_EMAIL = process.env.GOOGLE_SERVICE_EMAIL;
const LOYALTY_THRESHOLD = parseInt(process.env.LOYALTY_THRESHOLD || '5', 10);

// WhatsApp Cloud API
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;           // long-lived token
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;     // sender phone id
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'verify-me';
const DRIVER_NUMBERS = (process.env.DRIVER_NUMBERS || "").split(',').map(s=>s.trim()).filter(Boolean); // 9655xxxxxxx,9656yyyyyyy
const BASE_URL = process.env.BASE_URL || "";                 // e.g. https://your-service.onrender.com

// ======= MIDDLEWARE =======
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// health for Render
app.get('/healthz', (_,res)=>res.send('ok'));

// ======= SHEETS CLIENT =======
let sheets;
async function initSheets() {
  const auth = new google.auth.GoogleAuth({
    credentials: { private_key: GOOGLE_PRIVATE_KEY, client_email: GOOGLE_SERVICE_EMAIL },
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  sheets = google.sheets({ version: 'v4', auth });
  await ensureSheetsExist();
}
initSheets().catch(e => console.error('Sheets init error', e));

async function ensureSheetsExist() {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetTitles = new Set(meta.data.sheets.map(s => s.properties.title));

  const requests = [];
  if (!sheetTitles.has(SHEET_ORDERS)) requests.push({ addSheet: { properties: { title: SHEET_ORDERS } } });
  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests } });
  }

  // رؤوس الأعمدة
  await writeHeaderIfEmpty(SHEET_ORDERS, [
    'order_id','created_at','channel','client_name','phone','address',
    'items_json','total_usd','audio_url','transcript','status',
    'claimed_by','claimed_at','delivered_at','driver_phone'
  ]);
  await writeHeaderIfEmpty(SHEET_CUSTOMERS, [
    'client_phone','client_name','total_orders_lifetime','total_orders_this_month','last_order_month','loyalty_status'
  ]);
  await writeHeaderIfEmpty(SHEET_DRIVERS, [
    'driver_phone','driver_name','delivered_orders_lifetime','delivered_orders_this_month','last_delivery_month'
  ]);
}

async function writeHeaderIfEmpty(sheetName, headers) {
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A1:Z1`
  });
  const row = r.data.values?.[0] || [];
  if (row.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1:${columnLetter(headers.length)}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] }
    });
  }
}

function columnLetter(n) { let s='',t=n; while(t>0){let r=(t-1)%26; s=String.fromCharCode(65+r)+s; t=Math.floor((t-1)/26);} return s; }
function monthKey(d=new Date()){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }

async function appendRow(sheetName, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] }
  });
}
async function getAllRows(sheetName) {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A:Z` });
  return r.data.values || [];
}
async function updateRange(sheetName, rowIndex1Based, startColIndex1Based, values2D) {
  const startLetter = columnLetter(startColIndex1Based);
  const endLetter = columnLetter(startColIndex1Based + values2D[0].length - 1);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!${startLetter}${rowIndex1Based}:${endLetter}${rowIndex1Based}`,
    valueInputOption: 'RAW',
    requestBody: { values: values2D }
  });
}

// -------- Customers upsert --------
async function upsertCustomer({ phone, name }) {
  if (!phone) return;
  const rows = await getAllRows(SHEET_CUSTOMERS);
  const key = monthKey();
  let found = -1;
  for (let i=1;i<rows.length;i++){ if ((rows[i][0]||'')===phone){ found=i+1; break; } }

  if (found === -1) {
    const lifetime = 1, monthCount = 1;
    const loyalty = monthCount >= LOYALTY_THRESHOLD ? 'عميل دائم ✅' : 'عادي';
    await appendRow(SHEET_CUSTOMERS, [phone, name||'', lifetime, monthCount, key, loyalty]);
  } else {
    const row = rows[found-1];
    const lastKey = row[4] || '';
    let lifetime = parseInt(row[2]||'0',10)+1;
    let monthCount = parseInt(row[3]||'0',10);
    if (lastKey===key) monthCount+=1; else monthCount=1;
    const loyalty = monthCount >= LOYALTY_THRESHOLD ? 'عميل دائم ✅' : 'عادي';
    await updateRange(SHEET_CUSTOMERS, found, 2, [[ (name||row[1]||''), lifetime, monthCount, key, loyalty ]]);
  }
}

// -------- Drivers bump on delivered --------
async function bumpDriverDelivered({ driverPhone, driverName }) {
  if (!driverPhone) return;
  const rows = await getAllRows(SHEET_DRIVERS);
  const key = monthKey();
  let found=-1;
  for (let i=1;i<rows.length;i++){ if ((rows[i][0]||'')===driverPhone){ found=i+1; break; } }

  if (found === -1) {
    await appendRow(SHEET_DRIVERS, [driverPhone, driverName||'', 1, 1, key]);
  } else {
    const row = rows[found-1];
    const lastKey = row[4] || '';
    let life = parseInt(row[2]||'0',10)+1;
    let mon  = parseInt(row[3]||'0',10);
    if (lastKey===key) mon+=1; else mon=1;
    await updateRange(SHEET_DRIVERS, found, 2, [[ driverName||row[1]||'', life, mon, key ]]);
  }
}

// ======= Storefront =======
app.get('/', (req,res)=>res.sendFile(path.join(__dirname,'public/index.html')));

// Checkout (web)
app.post('/api/cart/checkout', upload.single('audio'), async (req,res)=>{
  try{
    const { name, phone, address, items, total } = req.body;
    if(!name || !phone || !address || !items) return res.status(400).json({ok:false,error:'missing fields'});
    const orderId = uuidv4();
    const audioUrl = req.file ? `/uploads/${req.file.filename}` : '';
    const created_at = new Date().toISOString();

    await appendRow(SHEET_ORDERS, [
      orderId, created_at, 'web', name||'', phone||'', address||'',
      items||'', total||'0', audioUrl, '', 'New', '', '', '', ''
    ]);
    await upsertCustomer({ phone, name });

    // Broadcast to drivers via WhatsApp (1:many)
    await broadcastOrderToDrivers({ orderId, name, phone, address, items, total });

    res.json({ ok:true, orderId });
  }catch(e){ console.error(e); res.status(500).json({ok:false,error:e.message}); }
});

// ======= Driver Claim =======
app.get('/driver/claim', async (req,res)=>{
  try{
    const { o:orderId, d:driverPhone } = req.query;
    if(!orderId || !driverPhone) return res.status(400).send('Missing params');
    const rows = await getAllRows(SHEET_ORDERS);
    let rowIndex=-1;
    for (let i=1;i<rows.length;i++){ if ((rows[i][0]||'')===orderId){ rowIndex=i+1; break; } }
    if (rowIndex===-1) return res.status(404).send('Order not found');

    const status = rows[rowIndex-1][10] || 'New';      // K
    const claimedBy = rows[rowIndex-1][11] || '';      // L
    if (status!=='New' && !(status==='Claimed' && claimedBy===driverPhone)) {
      return res.send('❌ الطلب غير متاح أو محجوز.');
    }

    const now = new Date().toISOString();
    await updateRange(SHEET_ORDERS, rowIndex, 11, [['Claimed', driverPhone, now, '', driverPhone]]);
    // أرسل خاص للسائق (اختياري)
    if (WHATSAPP_TOKEN && WHATSAPP_PHONE_ID) {
      await sendWhatsAppText(driverPhone, `✅ تم حجز الطلب #${orderId}. عند التوصيل اكتب: Delivered ${orderId}`);
    }
    res.send('✅ تم حجز الطلب لك.');
  }catch(e){ console.error(e); res.status(500).send('Error'); }
});

// ======= Mark Delivered (API) =======
app.post('/api/mark-delivered', async (req,res)=>{
  try{
    const { orderId, driverPhone, driverName } = req.body;
    if(!orderId || !driverPhone) return res.status(400).json({ok:false,error:'missing params'});
    const rows = await getAllRows(SHEET_ORDERS);
    let rowIndex=-1;
    for (let i=1;i<rows.length;i++){ if ((rows[i][0]||'')===orderId){ rowIndex=i+1; break; } }
    if (rowIndex===-1) return res.status(404).json({ok:false,error:'order not found'});

    const deliveredAt = new Date().toISOString();
    await updateRange(SHEET_ORDERS, rowIndex, 11, [['Delivered', '', '', deliveredAt, driverPhone]]);
    await bumpDriverDelivered({ driverPhone, driverName });

    res.json({ ok:true });
  }catch(e){ console.error(e); res.status(500).json({ok:false,error:e.message}); }
});

// ======= Admin: list orders =======
app.get('/api/admin/orders', async (req,res)=>{
  try{
    const rows = await getAllRows(SHEET_ORDERS);
    res.json({ ok:true, rows });
  }catch(e){ console.error(e); res.status(500).json({ok:false,error:e.message}); }
});

// ======= WhatsApp: webhook (Delivered <orderId>) =======
app.get('/api/whatsapp/webhook', (req,res)=>{
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});
app.post('/api/whatsapp/webhook', async (req,res)=>{
  try{
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (msg && msg.text && msg.from){
      const body = (msg.text.body||'').trim();
      const m = /^delivered\s+([a-f0-9\-]{8,})/i.exec(body);
      if (m){
        const orderId = m[1];
        const driverPhone = msg.from;
        await markDelivered(orderId, driverPhone);
        await sendWhatsAppText(driverPhone, `تم تأكيد تسليم الطلب #${orderId}. شكراً 🙏`);
      }
    }
    res.sendStatus(200);
  }catch(e){ console.error(e); res.sendStatus(200); }
});
async function markDelivered(orderId, driverPhone){
  const rows = await getAllRows(SHEET_ORDERS);
  let rowIndex=-1;
  for (let i=1;i<rows.length;i++){ if ((rows[i][0]||'')===orderId){ rowIndex=i+1; break; } }
  if (rowIndex===-1) return;
  const deliveredAt = new Date().toISOString();
  await updateRange(SHEET_ORDERS, rowIndex, 11, [['Delivered','', '', deliveredAt, driverPhone]]);
  await bumpDriverDelivered({ driverPhone });
}
async function sendWhatsAppText(toPhone, text){
  if(!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) return;
  const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_ID}/messages`;
  const payload = { messaging_product: "whatsapp", to: toPhone, type: "text", text: { body: text } };
  await fetch(url, { method:'POST', headers:{ 'Authorization':`Bearer ${WHATSAPP_TOKEN}`, 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
}
async function broadcastOrderToDrivers({ orderId, name, phone, address, items, total }){
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID || !BASE_URL || !DRIVER_NUMBERS.length) return;
  const claimBase = `${BASE_URL}/driver/claim?o=${encodeURIComponent(orderId)}&d=`;
  const text = `طلب جديد #${orderId}
العميل: ${name}
الهاتف: ${phone}
العنوان: ${address}
المنتجات: ${items}
الإجمالي: ${total} USD

أول سائق يضغط الرابط يحجز الطلب:
`;
  await Promise.all(DRIVER_NUMBERS.map(p => sendWhatsAppText(p, text + claimBase + encodeURIComponent(p))));
}

// ======= Twilio Voice (اختياري لكن مُفعّل) =======
app.get('/api/voice/ivr', (req,res)=>{
  res.type('text/xml').send(`
<Response>
  <Say language="ar-SA">أهلا عزيزي العميل، بعد الصافرة قل طلبك وعنوانك ورقم هاتفك بوضوح.</Say>
  <Record maxLength="90" action="/api/voice" method="POST" />
  <Say language="ar-SA">شكرا لك.</Say>
</Response>`.trim());
});
app.post('/api/voice', bodyParser.urlencoded({extended:true}), async (req,res)=>{
  try{
    const { RecordingUrl, From } = req.body;
    const orderId = uuidv4();
    let audioUrl = '';
    if (RecordingUrl){
      const r = await fetch(RecordingUrl + '.mp3');
      const buf = Buffer.from(await r.arrayBuffer());
      const local = `public/uploads/${orderId}.mp3`;
      fs.writeFileSync(local, buf);
      audioUrl = `/uploads/${orderId}.mp3`;
    }
    const created_at = new Date().toISOString();
    await appendRow(SHEET_ORDERS, [orderId, created_at, 'voice', '', From||'', '', '', '', audioUrl, '', 'New', '', '', '', '']);
    // بث للسائقين
    await broadcastOrderToDrivers({ orderId, name:'Voice Order', phone:From||'', address:'(صوتي)', items:'(صوتي)', total:'0' });
    res.type('text/xml').send(`<Response><Say language="ar-SA">تم تسجيل طلبك بنجاح، شكراً لك.</Say></Response>`);
  }catch(e){ console.error(e); res.type('text/xml').send('<Response><Say>خطأ.</Say></Response>'); }
});

// ======= Views =======
app.get('/admin', (req,res)=>res.sendFile(path.join(__dirname,'public/admin.html')));
app.get('/confirm', (req,res)=>res.sendFile(path.join(__dirname,'public/confirm.html')));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
