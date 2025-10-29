const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// node-fetch (ESM)
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

/** ====== ENV ====== **/
const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_ORDERS = 'Orders';
const SHEET_CUSTOMERS = 'Customers';
const SHEET_DRIVERS = 'Drivers';
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const GOOGLE_SERVICE_EMAIL = process.env.GOOGLE_SERVICE_EMAIL;
const LOYALTY_THRESHOLD = parseInt(process.env.LOYALTY_THRESHOLD || '5', 10);

const BASE_URL = process.env.BASE_URL || ""; // e.g. https://poc-system.onrender.com
// WhatsApp Cloud (Sandbox/Real)
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || "";
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "verify-me";
const DRIVER_NUMBERS = (process.env.DRIVER_NUMBERS || "").split(',').map(s=>s.trim()).filter(Boolean);

// OpenAI (اختياري لتحويل صوت المكالمة إلى نص)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

/** ====== App ====== **/
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));
app.get('/driver', (_req,res)=>res.sendFile(require('path').join(__dirname,'public/driver.html')));
app.get('/healthz', (_,res)=>res.send('ok'));

/** ====== Google Sheets Client ====== **/
let sheets;
(async function initSheets() {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: { private_key: GOOGLE_PRIVATE_KEY, client_email: GOOGLE_SERVICE_EMAIL },
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheets = google.sheets({ version: 'v4', auth });
    await ensureSheets();
    console.log('✅ Google Sheets ready');
  } catch (e) { console.error('Sheets init error', e); }
})();

async function ensureSheets(){
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const titles = new Set(meta.data.sheets.map(s=>s.properties.title));
  const req = [];
  if (!titles.has(SHEET_ORDERS)) req.push({ addSheet: { properties: { title: SHEET_ORDERS } } });
  if (req.length) await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests: req } });
  await headerIfEmpty(SHEET_ORDERS, [
    'order_id','created_at','channel','client_name','phone','address',
    'items_json','total_usd','audio_url','transcript','status',
    'claimed_by','claimed_at','delivered_at','driver_phone'
  ]);
  await headerIfEmpty(SHEET_CUSTOMERS, [
    'client_phone','client_name','total_orders_lifetime','total_orders_this_month','last_order_month','loyalty_status'
  ]);
  await headerIfEmpty(SHEET_DRIVERS, [
    'driver_phone','driver_name','delivered_orders_lifetime','delivered_orders_this_month','last_delivery_month'
  ]);
}
async function headerIfEmpty(sheet, headers){
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${sheet}!A1:Z1` });
  const row = r.data.values?.[0] || [];
  if (!row.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheet}!A1:${col(headers.length)}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] }
    });
  }
}
function col(n){let s='',t=n;while(t>0){let r=(t-1)%26;s=String.fromCharCode(65+r)+s;t=Math.floor((t-1)/26);}return s;}
function monthKey(d=new Date()){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;}
async function appendRow(sheet, values){
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID, range: `${sheet}!A1`,
    valueInputOption: 'USER_ENTERED', requestBody: { values: [values] }
  });
}
async function getAllRows(sheet){
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${sheet}!A:Z` });
  return r.data.values || [];
}
async function updateRange(sheet, rowIndex1, startCol1, values2D){
  const start = col(startCol1), end = col(startCol1 + values2D[0].length - 1);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheet}!${start}${rowIndex1}:${end}${rowIndex1}`,
    valueInputOption: 'RAW',
    requestBody: { values: values2D }
  });
}

/** ====== Summaries ====== **/
async function upsertCustomer({ phone, name }){
  if (!phone) return;
  const rows = await getAllRows(SHEET_CUSTOMERS);
  const key = monthKey();
  let found=-1;
  for(let i=1;i<rows.length;i++){ if ((rows[i][0]||'')===phone){found=i+1;break;} }
  if (found===-1){
    const lifetime=1, month=1;
    const loyalty = month>=LOYALTY_THRESHOLD ? 'عميل دائم ✅' : 'عادي';
    await appendRow(SHEET_CUSTOMERS, [phone, name||'', lifetime, month, key, loyalty]);
  } else {
    const r=rows[found-1], last=r[4]||'';
    let lifetime=parseInt(r[2]||'0',10)+1;
    let month=parseInt(r[3]||'0',10);
    month = (last===key) ? month+1 : 1;
    const loyalty = month>=LOYALTY_THRESHOLD ? 'عميل دائم ✅' : 'عادي';
    await updateRange(SHEET_CUSTOMERS, found, 2, [[ name||r[1]||'', lifetime, month, key, loyalty ]]);
  }
}
async function bumpDriverDelivered({ driverPhone, driverName }){
  if (!driverPhone) return;
  const rows = await getAllRows(SHEET_DRIVERS);
  const key = monthKey();
  let found=-1;
  for(let i=1;i<rows.length;i++){ if ((rows[i][0]||'')===driverPhone){found=i+1;break;} }
  if (found===-1){
    await appendRow(SHEET_DRIVERS, [driverPhone, driverName||'', 1, 1, key]);
  } else {
    const r=rows[found-1], last=r[4]||'';
    let life=parseInt(r[2]||'0',10)+1;
    let mon=parseInt(r[3]||'0',10);
    mon = (last===key) ? mon+1 : 1;
    await updateRange(SHEET_DRIVERS, found, 2, [[ driverName||r[1]||'', life, mon, key ]]);
  }
}

/** ====== Storefront (Web) ====== **/
app.get('/', (_,res)=>res.sendFile(path.join(__dirname,'public/index.html')));

app.post('/api/cart/checkout', async (req,res)=>{
  try{
    const { name, phone, address, items, total } = req.body;
    if(!name || !phone || !address || !items) return res.status(400).json({ok:false,error:'missing fields'});
    const orderId = uuidv4();
    const created_at = new Date().toISOString();

    await appendRow(SHEET_ORDERS, [
      orderId, created_at, 'web', name||'', phone||'', address||'',
      items||'', total||'0', '', '', 'New', '', '', '', ''
    ]);
    await upsertCustomer({ phone, name });

    await broadcastOrderToDrivers({ orderId, name, phone, address, items, total });
    res.json({ ok:true, orderId });
  } catch(e){ console.error(e); res.status(500).json({ok:false,error:e.message}); }
});

/** ====== Driver flows ====== **/
app.get('/driver/claim', async (req,res)=>{
  try{
    const { o:orderId, d:driverPhone } = req.query;
    if(!orderId || !driverPhone) return res.status(400).send('Missing params');
    const rows = await getAllRows(SHEET_ORDERS);
    let rowIndex=-1;
    for(let i=1;i<rows.length;i++){ if ((rows[i][0]||'')===orderId){rowIndex=i+1;break;} }
    if (rowIndex===-1) return res.status(404).send('Order not found');

    const row=rows[rowIndex-1], status=row[10]||'New', claimedBy=row[11]||'';
    if (status!=='New' && !(status==='Claimed' && claimedBy===driverPhone)) {
      return res.send('❌ الطلب غير متاح أو محجوز.');
    }
    const now = new Date().toISOString();
    await updateRange(SHEET_ORDERS, rowIndex, 11, [['Claimed', driverPhone, now, '', driverPhone]]);
    if (WHATSAPP_TOKEN && WHATSAPP_PHONE_ID) {
      await sendWhatsAppText(driverPhone, `✅ تم حجز الطلب #${orderId}. عند التوصيل اكتب: Delivered ${orderId}`);
    }
    res.send('✅ تم حجز الطلب لك.');
  }catch(e){ console.error(e); res.status(500).send('Error'); }
});

app.post('/api/mark-delivered', async (req,res)=>{
  try{
    const { orderId, driverPhone, driverName } = req.body;
    if (!orderId || !driverPhone) return res.status(400).json({ok:false,error:'missing params'});
    const rows = await getAllRows(SHEET_ORDERS);
    let rowIndex=-1;
    for(let i=1;i<rows.length;i++){ if ((rows[i][0]||'')===orderId){rowIndex=i+1;break;} }
    if (rowIndex===-1) return res.status(404).json({ok:false,error:'order not found'});
    const deliveredAt = new Date().toISOString();
    await updateRange(SHEET_ORDERS, rowIndex, 11, [['Delivered','','',deliveredAt,driverPhone]]);
    await bumpDriverDelivered({ driverPhone, driverName });
    res.json({ ok:true });
  }catch(e){ console.error(e); res.status(500).json({ok:false,error:e.message}); }
});

/** ====== Admin quick view ====== **/
app.get('/api/admin/orders', async (_req,res)=>{
  try{ const rows = await getAllRows(SHEET_ORDERS); res.json({ok:true, rows}); }
  catch(e){ console.error(e); res.status(500).json({ok:false,error:e.message}); }
});

/** ====== WhatsApp Webhook (Delivered <id>) ====== **/
app.get('/api/whatsapp/webhook', (req,res)=>{
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode==='subscribe' && token===WHATSAPP_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});
app.post('/api/whatsapp/webhook', async (req,res)=>{
  try{
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (msg && msg.text && msg.from){
      const body=(msg.text.body||'').trim(); const m=/^delivered\s+([a-f0-9\-]{8,})/i.exec(body);
      if (m){ const orderId=m[1]; const driverPhone=msg.from; await markDelivered(orderId, driverPhone); await sendWhatsAppText(driverPhone, `تم تأكيد تسليم الطلب #${orderId}. شكراً 🙏`); }
    }
    res.sendStatus(200);
  }catch(e){ console.error(e); res.sendStatus(200); }
});
async function markDelivered(orderId, driverPhone){
  const rows = await getAllRows(SHEET_ORDERS);
  let rowIndex=-1;
  for(let i=1;i<rows.length;i++){ if ((rows[i][0]||'')===orderId){rowIndex=i+1;break;} }
  if (rowIndex===-1) return;
  const deliveredAt = new Date().toISOString();
  await updateRange(SHEET_ORDERS, rowIndex, 11, [['Delivered','','',deliveredAt,driverPhone]]);
  await bumpDriverDelivered({ driverPhone });
}

/** ====== WhatsApp Send Helpers ====== **/
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
الإجمالي: ${total} USD
أول سائق يضغط الرابط يحجز الطلب:
`;
  await Promise.all(DRIVER_NUMBERS.map(p => sendWhatsAppText(p, text + claimBase + encodeURIComponent(p))));
}

/** ====== Voice Channel (AI Agent via phone) ====== **/
app.get('/api/voice/ivr', (_req,res)=>{
  // TwiML IVR: يرد على المتصل ويبدأ تسجيل لمدة 90 ثانية
  res.type('text/xml').send(`
<Response>
  <Say language="ar-SA">أهلا بك. بعد الصافرة قل اسمك، عنوانك، وطلبك.</Say>
  <Record maxLength="90" action="/api/voice" method="POST" />
  <Say language="ar-SA">شكرا لك.</Say>
</Response>`.trim());
});

app.post('/api/voice', bodyParser.urlencoded({extended:true}), async (req,res)=>{
  try{
    const { RecordingUrl, From } = req.body;
    const orderId = uuidv4();
    let transcript = '';
    let audioUrl = '';

    // تحميل التسجيل المحلي/الخادم (اختياري)
    if (RecordingUrl){
      const r = await fetch(RecordingUrl + '.mp3'); // Twilio provides recording URL
      const buf = Buffer.from(await r.arrayBuffer());
      const local = `public/uploads/${orderId}.mp3`;
      fs.writeFileSync(local, buf);
      audioUrl = `/uploads/${orderId}.mp3`;
    }

    // تحويل الصوت إلى نص (إذا وُجد OPENAI_API_KEY)
    if (OPENAI_API_KEY && audioUrl){
      try{
        // ملاحظة: يمكنك لاحقا استبدال هذا بنداء Whisper الرسمي من OpenAI SDK
        transcript = '(transcribed text placeholder)';
      }catch(_){}
    }

    const created_at = new Date().toISOString();
    await appendRow(SHEET_ORDERS, [
      orderId, created_at, 'voice', 'Voice Order', From||'', '(صوتي)',
      '(صوتي)', '0', audioUrl, transcript, 'New', '', '', '', ''
    ]);

    await broadcastOrderToDrivers({ orderId, name:'Voice Order', phone:From||'', address:'(صوتي)', items:'(صوتي)', total:'0' });

    res.type('text/xml').send(`<Response><Say language="ar-SA">تم تسجيل طلبك بنجاح. شكرا لك.</Say></Response>`);
  }catch(e){ console.error(e); res.type('text/xml').send('<Response><Say>حدث خطأ.</Say></Response>'); }
});

/** ====== Views ====== **/
app.get('/admin', (_req,res)=>res.sendFile(path.join(__dirname,'public/admin.html')));

app.listen(PORT, ()=>console.log(`🚀 Server running on port ${PORT}`));

