require('dotenv').config();
const express = require('express');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const axios   = require('axios');
const multer  = require('multer');
const QRCode  = require('qrcode');

const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '50mb' }));
app.use(express.static('.'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── UPLOAD DE VÍDEO / MÍDIA ──
fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(__dirname, 'data'),    { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename:    (req, file, cb) => cb(null, Date.now() + '_' + Math.random().toString(36).substr(2,6) + path.extname(file.originalname)),
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  res.json({ success: true, url: '/uploads/' + req.file.filename });
});

// ── CERTIFICADO EFÍ BANK (mTLS) ──
let efiAgent = null;
const certPath = path.join(__dirname, 'certificado.p12');
if (fs.existsSync(certPath)) {
  efiAgent = new https.Agent({
    pfx: fs.readFileSync(certPath),
    passphrase: process.env.EFI_CERT_PASSPHRASE || '',
  });
  console.log('✅ Certificado Efí Bank carregado');
} else {
  console.warn('⚠️  certificado.p12 não encontrado — coloque na pasta do projeto');
}

console.log('🔎 EFI_CLIENT_ID definido:', !!process.env.EFI_CLIENT_ID);
console.log('🔎 EFI_CLIENT_SECRET definido:', !!process.env.EFI_CLIENT_SECRET);
console.log('🔎 EFI_PIX_KEY definido:', !!process.env.EFI_PIX_KEY);

const EFI_BASE = 'https://pix.api.efipay.com.br';
let _efiToken = null;
let _efiTokenExpiry = 0;

async function getEfiToken() {
  if (_efiToken && Date.now() < _efiTokenExpiry) return _efiToken;
  const resp = await axios.post(
    `${EFI_BASE}/oauth/token`,
    { grant_type: 'client_credentials' },
    {
      httpsAgent: efiAgent,
      auth: {
        username: process.env.EFI_CLIENT_ID,
        password: process.env.EFI_CLIENT_SECRET,
      },
      headers: { 'Content-Type': 'application/json' },
    }
  );
  _efiToken = resp.data.access_token;
  _efiTokenExpiry = Date.now() + ((resp.data.expires_in || 3600) - 60) * 1000;
  return _efiToken;
}

// ── ARMAZENAMENTO DAS CARTINHAS (arquivo JSON no disco) ──
const DATA_FILE = path.join(__dirname, 'data', 'cartinhas.json');

function lerCartinhas() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {}
  return {};
}

function gravarCartinhas(obj) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(obj), 'utf8');
}

app.post('/api/cartinha/salvar', (req, res) => {
  const id   = 'carta_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  const todas = lerCartinhas();
  todas[id]  = { ...req.body, id, criadoEm: new Date().toISOString() };
  gravarCartinhas(todas);
  res.json({ success: true, id });
});

app.get('/api/cartinha/:id', (req, res) => {
  const todas = lerCartinhas();
  const data  = todas[req.params.id];
  if (!data) return res.status(404).json({ error: 'Cartinha não encontrada' });
  res.json({ success: true, data });
});

// ── GERAÇÃO DE MENSAGEM VIA IA ──
app.post('/api/generate', async (req, res) => {
  const { prompt } = req.body;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada.' });
  try {
    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await aiResp.json();
    const text = data.content?.[0]?.text;
    if (text) return res.json({ text });
    res.status(500).json({ error: 'Não foi possível gerar a mensagem.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao conectar com a IA.', detail: err.message });
  }
});

// ── PIX VIA EFÍ BANK (QR code EMV nativo) ──
app.post('/api/pix', async (req, res) => {
  const { nome, cartinhaId } = req.body;

  if (!efiAgent) {
    return res.status(500).json({ error: 'certificado.p12 não encontrado. Coloque o arquivo na pasta do projeto.' });
  }
  if (!process.env.EFI_CLIENT_ID || !process.env.EFI_CLIENT_SECRET || !process.env.EFI_PIX_KEY) {
    return res.status(500).json({ error: 'Credenciais Efí Bank não configuradas no .env (EFI_CLIENT_ID, EFI_CLIENT_SECRET, EFI_PIX_KEY)' });
  }

  try {
    const token = await getEfiToken();

    // Criar cobrança PIX imediata
    const cobResp = await axios.post(
      `${EFI_BASE}/v2/cob`,
      {
        calendario: { expiracao: 3600 },
        valor: { original: '19.90' },
        chave: process.env.EFI_PIX_KEY,
        solicitacaoPagador: 'Carta do Coracao',
      },
      {
        httpsAgent: efiAgent,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      }
    );

    const { txid, loc } = cobResp.data;

    // Obter QR code EMV (imagem base64 + string copia e cola)
    const qrResp = await axios.get(
      `${EFI_BASE}/v2/loc/${loc.id}/qrcode`,
      {
        httpsAgent: efiAgent,
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    const { qrcode, imagemQrcode } = qrResp.data;

    res.json({
      success: true,
      id: txid,
      pixCopiaCola: qrcode,
      qrCodeBase64: imagemQrcode,
    });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('Erro Efí PIX:', JSON.stringify(detail));
    res.status(500).json({ error: 'Erro ao gerar PIX', detail });
  }
});

// ── QR CODE DA CARTINHA ──
app.get('/api/qrcode', async (req, res) => {
  const { cid } = req.query;
  if (!cid) return res.status(400).json({ error: 'cid obrigatório' });
  const url = `${req.protocol}://${req.get('host')}/cartinha.html?cid=${encodeURIComponent(cid)}`;
  try {
    const dataUrl = await QRCode.toDataURL(url, { width: 280, margin: 2, color: { dark: '#1a0010', light: '#ffffff' } });
    res.json({ success: true, qr: dataUrl });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao gerar QR Code' });
  }
});

// ── VERIFICAR STATUS DO PIX ──
app.get('/api/pix/check', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'ID obrigatório' });
  if (!efiAgent) return res.json({ status: 'UNKNOWN' });

  try {
    const token = await getEfiToken();
    const r = await axios.get(
      `${EFI_BASE}/v2/cob/${id}`,
      {
        httpsAgent: efiAgent,
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    res.json({ status: r.data.status });
  } catch (err) {
    const detail = err.response?.data || err.message;
    res.status(500).json({ error: err.message, detail });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});
