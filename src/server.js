import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import {
  startWhatsAppBot,
  getBotState,
  requestPhonePairingCode,
  resetWhatsAppSession,
  sendOrderCouponToWA,
  sendNotificationToWA,
  checkWhatsAppPhoneWithProfile,
  setQueuePauseState,
  clearPendingQueue,
} from './waEngine.js';
import { renderCouponJpegBuffer } from './couponRenderer.js';

const app = express();
const PORT = Number(process.env.PORT || 3100);
const BOT_SECRET = String(
  process.env.WA_BOT_SECRET || 'GLORIUS_WA_BOT_SECRET_2026'
).trim();

app.use(cors());
app.use(express.json({ limit: '5mb' }));

/**
 * Middleware autentikasi webhook dari Web Utama (Vercel) atau Dashboard Bot
 */
function verifyBotSecret(req, res, next) {
  if (!BOT_SECRET) return next();

  const headerSecret =
    req.headers['x-bot-secret'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() ||
    req.body?.secret ||
    req.query?.secret;

  if (headerSecret === BOT_SECRET) {
    return next();
  }

  return res.status(401).json({
    status: 'error',
    message: 'WA_BOT_SECRET tidak cocok atau tidak disertakan.',
  });
}

// ============================================================================
// 1. ENDPOINT KEEP-ALIVE 24 JAM (UNTUK CRON-JOB.ORG / UPTIMEROBOT)
// ============================================================================
app.get('/ping', (_req, res) => {
  const state = getBotState();
  res.status(200).json({
    status: 'alive',
    service: 'glorius-wa-bot-xi-g',
    wa_status: state.status,
    wa_connected: state.connected,
    uptime_seconds: state.uptimeSeconds,
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (_req, res) => {
  const state = getBotState();
  res.status(200).json({
    status: 'ok',
    ...state,
  });
});

// ============================================================================
// 2. ENDPOINT STATUS & PAIRING (UNTUK PANEL WEB BOT & DASHBOARD KASIR)
// ============================================================================
app.get('/api/status', (_req, res) => {
  res.json({
    status: 'success',
    ...getBotState(),
  });
});

app.post('/api/pair', verifyBotSecret, async (req, res) => {
  try {
    const phone = String(req.body?.phone || '').trim();
    const result = await requestPhonePairingCode(phone);
    res.json({
      status: 'success',
      ...result,
    });
  } catch (err) {
    res.status(400).json({
      status: 'error',
      message: err?.message || 'Gagal meminta Pairing Code.',
    });
  }
});

app.post('/api/reset-session', verifyBotSecret, async (_req, res) => {
  try {
    await resetWhatsAppSession();
    res.json({
      status: 'success',
      message: 'Sesi WhatsApp direset. Silakan scan QR atau minta Pairing Code baru.',
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: err?.message || 'Gagal mereset sesi.',
    });
  }
});

// ============================================================================
// 2A. ENDPOINT KONTROL ANTREAN AMAN (PAUSE / RESUME / CLEAR QUEUE)
// ============================================================================
app.post('/api/queue/pause', verifyBotSecret, (req, res) => {
  const paused = req.body?.paused !== false;
  const result = setQueuePauseState(paused);
  res.json({
    status: 'success',
    message: paused ? 'Antrean pesan dijeda sementara.' : 'Antrean pesan dilanjutkan.',
    ...result,
  });
});

app.post('/api/queue/clear', verifyBotSecret, (_req, res) => {
  const result = clearPendingQueue();
  res.json({
    status: 'success',
    message: `Berhasil membersihkan ${result.clearedCount} antrean pesan.`,
    ...result,
  });
});

// ============================================================================
// 2B. ENDPOINT VERIFIKASI AKUN WHATSAPP & PUSH NAME (/api/check-phone)
// ============================================================================
app.all('/api/check-phone', async (req, res) => {
  try {
    const rawPhone = req.body?.phone || req.query?.phone;
    if (!rawPhone) {
      return res.status(400).json({
        status: 'error',
        valid: false,
        message: 'Parameter phone wajib disertakan.',
      });
    }
    const result = await checkWhatsAppPhoneWithProfile(rawPhone);
    return res.json({
      status: 'success',
      ...result,
    });
  } catch (err) {
    return res.status(500).json({
      status: 'error',
      valid: false,
      message: err?.message || 'Gagal memverifikasi nomor telepon.',
    });
  }
});

// ============================================================================
// 3. ENDPOINT PREVIEW GAMBAR E-KUPON DINAMIS (GET /api/coupon-preview)
// ============================================================================
app.get('/api/coupon-preview', async (req, res) => {
  try {
    const sampleTicket = {
      ticket_code: req.query.code || 'GLR-8492',
      customer_name: req.query.name || 'Nabila Putri',
      class_name: req.query.class || 'XI-G',
      total_price: Number(req.query.total || 35000),
      payment_method: req.query.method || 'TRANSFER',
      payment_status: req.query.status || 'LUNAS',
      is_collected: req.query.collected === '1',
      items: [
        { name: 'Cireng Ayam Suwir Pedas', qty: 2, price: 8000 },
        { name: 'Chicken Katsu Saus Kari', qty: 1, price: 12000 },
        { name: 'Es Kuwut Segar Bali', qty: 2, price: 3500 },
      ],
    };

    const jpgBuffer = await renderCouponJpegBuffer(sampleTicket);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(jpgBuffer);
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: err?.message || 'Gagal merender preview E-Kupon.',
    });
  }
});

// ============================================================================
// 4. ENDPOINT UTAMA: AUTO-SEND E-KUPON DARI WEB VERCEL (POST /api/send-coupon)
// ============================================================================
app.post('/api/send-coupon', verifyBotSecret, async (req, res) => {
  try {
    const ticket = req.body?.ticket || req.body;
    if (!ticket || !ticket.ticket_code) {
      return res.status(400).json({
        status: 'error',
        message: 'Payload tiket pesanan tidak lengkap (ticket_code wajib ada).',
      });
    }

    const result = await sendOrderCouponToWA(ticket, {
      phone: req.body?.phone || ticket.wa_number,
      webBaseUrl: req.body?.web_base_url || process.env.PUBLIC_WEB_URL,
    });

    if (!result.success) {
      return res.status(400).json({
        status: 'error',
        message: result.error || 'Gagal mengirim E-Kupon.',
      });
    }

    return res.json({
      status: 'success',
      ...result,
    });
  } catch (err) {
    console.error('[POST /api/send-coupon] Error:', err?.message);
    return res.status(500).json({
      status: 'error',
      message: err?.message || 'Gagal mengirim E-Kupon ke WhatsApp.',
    });
  }
});

// ============================================================================
// 5. ENDPOINT NOTIFIKASI PANGGILAN KE STAND / KLAIM (POST /api/send-notification)
// ============================================================================
app.post('/api/send-notification', verifyBotSecret, async (req, res) => {
  try {
    const result = await sendNotificationToWA(req.body || {});
    if (!result.success) {
      return res.status(400).json({
        status: 'error',
        message: result.error || 'Gagal mengirim notifikasi WA.',
      });
    }
    return res.json({
      status: 'success',
      ...result,
    });
  } catch (err) {
    console.error('[POST /api/send-notification] Error:', err?.message);
    return res.status(500).json({
      status: 'error',
      message: err?.message || 'Gagal mengirim notifikasi WhatsApp.',
    });
  }
});

// ============================================================================
// 6. PANEL KONTROL WEB INTERAKTIF (GET /)
// ============================================================================
app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Panel Bot WhatsApp 24/7 — Stand Bazar Glorius (XI-G)</title>
  <style>
    :root {
      --bg: #FBF9F4;
      --card: #FFFFFF;
      --forest: #5B7E48;
      --forest-dark: #3F5B30;
      --forest-soft: #EAF1E4;
      --teak: #301C10;
      --muted: #7A6454;
      --border: #E5DEC9;
      --amber: #D97706;
      --amber-soft: #FEF3C7;
      --crimson: #C53030;
      --crimson-soft: #FDE8E8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: 'Plus Jakarta Sans', 'Segoe UI', system-ui, sans-serif;
      background: var(--bg);
      color: var(--teak);
      line-height: 1.5;
    }
    .container {
      max-width: 1020px;
      margin: 0 auto;
      padding: 24px 16px 64px;
    }
    .header {
      background: linear-gradient(135deg, #5B7E48 0%, #3F5B30 100%);
      color: #fff;
      padding: 24px;
      border-radius: 22px;
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 22px;
      box-shadow: 0 14px 32px -10px rgba(63, 91, 48, 0.35);
    }
    .header h1 { margin: 4px 0; font-size: 1.45rem; }
    .header p { margin: 0; font-size: 0.86rem; opacity: 0.9; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border-radius: 999px;
      font-weight: 800;
      font-size: 0.82rem;
      background: rgba(255,255,255,0.18);
      color: #fff;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #FBBF24;
    }
    .dot.online { background: #4ADE80; box-shadow: 0 0 10px #4ADE80; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(310px, 1fr));
      gap: 20px;
      margin-bottom: 20px;
    }
    .card {
      background: var(--card);
      border: 1.5px solid var(--border);
      border-radius: 20px;
      padding: 20px;
      box-shadow: 0 8px 22px -8px rgba(48, 28, 16, 0.06);
    }
    .card h2 {
      margin: 0 0 6px;
      font-size: 1.1rem;
    }
    .sub {
      font-size: 0.82rem;
      color: var(--muted);
      margin-bottom: 16px;
    }
    .qr-box {
      background: var(--bg);
      border: 2px dashed var(--border);
      border-radius: 16px;
      padding: 18px;
      text-align: center;
      min-height: 260px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .qr-box img {
      max-width: 240px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: #fff;
      padding: 6px;
    }
    label {
      display: block;
      font-size: 0.78rem;
      font-weight: 800;
      margin-bottom: 6px;
      color: var(--teak);
    }
    input {
      width: 100%;
      padding: 10px 14px;
      border-radius: 12px;
      border: 1.5px solid var(--border);
      font-size: 0.9rem;
      font-family: inherit;
      margin-bottom: 12px;
      background: #fff;
    }
    button {
      cursor: pointer;
      border: none;
      border-radius: 12px;
      padding: 11px 16px;
      font-weight: 800;
      font-size: 0.86rem;
      font-family: inherit;
      transition: all 0.15s ease;
    }
    .btn-primary {
      background: var(--forest);
      color: #fff;
      width: 100%;
    }
    .btn-primary:hover { background: var(--forest-dark); }
    .btn-soft {
      background: var(--bg);
      color: var(--teak);
      border: 1px solid var(--border);
    }
    .btn-danger {
      background: var(--crimson-soft);
      color: var(--crimson);
    }
    .pairing-display {
      margin-top: 12px;
      padding: 14px;
      border-radius: 14px;
      background: var(--forest-soft);
      border: 1.5px solid var(--forest);
      text-align: center;
      font-family: monospace;
      font-size: 1.55rem;
      font-weight: 900;
      letter-spacing: 0.12em;
      color: var(--forest-dark);
      display: none;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.82rem;
    }
    th, td {
      text-align: left;
      padding: 10px 8px;
      border-bottom: 1px solid var(--border);
    }
    th { color: var(--muted); font-size: 0.74rem; text-transform: uppercase; }
    .pill {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-weight: 800;
      font-size: 0.7rem;
    }
    .pill-sent { background: var(--forest-soft); color: var(--forest-dark); }
    .pill-queued { background: var(--amber-soft); color: var(--amber); }
    .pill-failed { background: var(--crimson-soft); color: var(--crimson); }
    .notice {
      padding: 10px 14px;
      border-radius: 12px;
      font-size: 0.82rem;
      font-weight: 700;
      margin-top: 10px;
      display: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <div style="font-size: 0.72rem; font-weight: 800; letter-spacing: 0.08em; opacity: 0.85;">
          MICROSERVICE TERPISAH • STAND BAZAR GLORIUS (XI-G)
        </div>
        <h1>🤖 Server Bot WhatsApp & Generator E-Kupon HD</h1>
        <p id="user-info">Memeriksa status koneksi WhatsApp...</p>
      </div>
      <div>
        <div class="badge" id="status-badge">
          <span class="dot" id="status-dot"></span>
          <span id="status-text">MEMUAT...</span>
        </div>
      </div>
    </div>

    <div class="grid">
      <!-- Kiri: Koneksi QR / Pairing Code -->
      <div class="card">
        <h2>1. Koneksi Nomor WhatsApp Panitia</h2>
        <div class="sub">Scan QR Code di bawah dari HP Panitia (Perangkat Tertaut) ATAU gunakan kode Pairing 8 digit.</div>

        <div class="qr-box" id="qr-container">
          <div style="color: var(--muted); font-weight: 700;">Menunggu status dari server...</div>
        </div>

        <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border);">
          <label>Kunci Rahasia Bot (WA_BOT_SECRET)</label>
          <input type="password" id="bot-secret" placeholder="Masukkan WA_BOT_SECRET" value="GLORIUS_WA_BOT_SECRET_2026" />

          <label>Alternatif Tanpa Kamera: Masukkan No. WA Bot untuk Pairing Code</label>
          <div style="display: flex; gap: 8px;">
            <input type="tel" id="pair-phone" placeholder="Contoh: 081234567890" style="margin-bottom: 0;" />
            <button type="button" class="btn-soft" onclick="requestPairing()" style="white-space: nowrap;">Minta Kode</button>
          </div>
          <div class="pairing-display" id="pairing-box"></div>
        </div>

        <div style="margin-top: 14px; display: flex; justify-content: space-between; align-items: center;">
          <span style="font-size: 0.76rem; color: var(--muted);" id="uptime-label">Uptime: 0s</span>
          <button type="button" class="btn-danger" style="padding: 7px 12px; font-size: 0.76rem;" onclick="resetSession()">Reset / Ganti Nomor WA</button>
        </div>
      </div>

      <!-- Kanan: Simulasi & Uji Kirim E-Kupon -->
      <div class="card">
        <h2>2. Uji Kirim E-Kupon HD Otomatis</h2>
        <div class="sub">Tes langsung pengiriman gambar E-Kupon (1344×630) + QR Code ke nomor WhatsApp kamu.</div>

        <div style="margin-bottom: 14px; border-radius: 14px; overflow: hidden; border: 1px solid var(--border);">
          <img src="/api/coupon-preview" alt="Preview E-Kupon" style="width: 100%; display: block;" />
        </div>

        <label>Nomor WhatsApp Tujuan Tes</label>
        <input type="tel" id="test-phone" placeholder="Contoh: 081234567890" />

        <label>Nama Pemesan Simulasi</label>
        <input type="text" id="test-name" value="Nabila Putri" />

        <button type="button" class="btn-primary" id="btn-test" onclick="sendTestCoupon()">
          🚀 Kirim Contoh E-Kupon HD ke WA Sekarang
        </button>
        <div class="notice" id="test-notice"></div>
      </div>
    </div>

    <!-- Log Pengiriman & Kontrol Antrean Aman -->
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 12px;">
        <div>
          <h2>3. Antrean Pesan & Riwayat Pengiriman (Anti-Ban Protected)</h2>
          <div class="sub" style="margin-bottom: 0;">
            Pacing Human-Like: Jeda aman 4.0–7.5 detik per pesan &bull; Endpoint Keep-Alive: <code>GET /ping</code>
          </div>
        </div>
        <div style="display: flex; gap: 8px;">
          <button type="button" class="btn-soft" id="btn-pause-queue" onclick="togglePauseQueue()" style="padding: 7px 14px; font-size: 0.78rem;">
            ⏸️ Jeda Antrean
          </button>
          <button type="button" class="btn-danger" onclick="clearQueue()" style="padding: 7px 14px; font-size: 0.78rem;">
            🗑️ Bersihkan Antrean (<span id="queue-count">0</span>)
          </button>
        </div>
      </div>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>Waktu</th>
              <th>Tipe</th>
              <th>Kode Tiket</th>
              <th>Penerima</th>
              <th>Status</th>
              <th>Keterangan</th>
            </tr>
          </thead>
          <tbody id="logs-body">
            <tr><td colspan="6" style="text-align:center; color: var(--muted);">Belum ada riwayat pengiriman.</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    async function pollStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        const dot = document.getElementById('status-dot');
        const text = document.getElementById('status-text');
        const info = document.getElementById('user-info');
        const qrBox = document.getElementById('qr-container');
        const upLabel = document.getElementById('uptime-label');

        const mins = Math.floor((data.uptimeSeconds || 0) / 60);
        upLabel.textContent = 'Uptime Server: ' + mins + ' menit (' + (data.uptimeSeconds || 0) + ' dtk)';

        const qCount = document.getElementById('queue-count');
        if (qCount) qCount.textContent = data.queueLength || '0';

        const pauseBtn = document.getElementById('btn-pause-queue');
        if (pauseBtn) {
          pauseBtn.textContent = data.isQueuePaused ? '▶️ Lanjutkan Antrean' : '⏸️ Jeda Antrean';
          pauseBtn.style.background = data.isQueuePaused ? 'var(--amber-soft)' : 'var(--bg)';
          pauseBtn.style.color = data.isQueuePaused ? 'var(--amber)' : 'var(--teak)';
        }

        if (data.connected) {
          dot.className = 'dot online';
          text.textContent = 'TERHUBUNG KE WHATSAPP (ANTI-BAN PROTECTED)';
          info.textContent = 'Nomor Bot Aktif: ' + (data.user?.id || 'Terhubung') + ' (' + (data.user?.name || 'Stand Glorius') + ')';
          qrBox.innerHTML = '<div style="color: var(--forest); font-weight: 800; font-size: 1.05rem;">✅ WhatsApp Bot Sudah Terhubung!</div><div style="font-size: 0.82rem; color: var(--muted); margin-top: 6px;">Dilengkapi Pacing Human-Like & Auto Heartbeat untuk mencegah pemblokiran.</div>';
        } else if (data.status === 'WAITING_QR' && data.qrDataUrl) {
          dot.className = 'dot';
          text.textContent = 'MENUNGGU SCAN QR / PAIRING';
          info.textContent = 'Buka aplikasi WhatsApp di HP -> Perangkat Tertaut -> Tautkan Perangkat';
          qrBox.innerHTML = '<img src="' + data.qrDataUrl + '" alt="QR Code WhatsApp" /><div style="font-size: 0.78rem; color: var(--muted); margin-top: 8px; font-weight: 700;">Scan QR ini dari aplikasi WhatsApp HP Panitia</div>';
        } else {
          dot.className = 'dot';
          text.textContent = data.status || 'MENYAMBUNGKAN...';
          info.textContent = 'Sedang menyiapkan koneksi WebSocket ke server WhatsApp...';
          qrBox.innerHTML = '<div style="color: var(--muted); font-weight: 700;">⏳ Sedang memuat sesi / membuat QR Code...</div>';
        }

        const tbody = document.getElementById('logs-body');
        if (Array.isArray(data.logs) && data.logs.length > 0) {
          tbody.innerHTML = data.logs.map(l => {
            const pillClass = l.status === 'SENT' ? 'pill-sent' : l.status === 'QUEUED' ? 'pill-queued' : 'pill-failed';
            return '<tr>' +
              '<td>' + l.timestamp + '</td>' +
              '<td><strong>' + l.type + '</strong></td>' +
              '<td style="font-family:monospace;font-weight:700;">' + (l.ticket_code || '-') + '</td>' +
              '<td>' + (l.customer_name || '') + ' (' + (l.phone || '-') + ')</td>' +
              '<td><span class="pill ' + pillClass + '">' + l.status + '</span></td>' +
              '<td>' + (l.detail || '') + '</td>' +
            '</tr>';
          }).join('');
        }
      } catch (e) {}
    }

    async function requestPairing() {
      const phone = document.getElementById('pair-phone').value.trim();
      const secret = document.getElementById('bot-secret').value.trim();
      const box = document.getElementById('pairing-box');
      if (!phone) return alert('Masukkan nomor WA terlebih dahulu.');
      box.style.display = 'block';
      box.textContent = 'Meminta kode...';
      try {
        const res = await fetch('/api/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-bot-secret': secret },
          body: JSON.stringify({ phone })
        });
        const data = await res.json();
        if (res.ok && data.pairingCode) {
          box.textContent = data.pairingCode;
        } else {
          box.textContent = data.message || 'Gagal meminta kode';
        }
      } catch (err) {
        box.textContent = 'Gagal menghubungi server';
      }
    }

    async function resetSession() {
      if (!confirm('Yakin ingin mereset / mengeluarkan sesi WhatsApp saat ini?')) return;
      const secret = document.getElementById('bot-secret').value.trim();
      await fetch('/api/reset-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bot-secret': secret }
      });
      setTimeout(pollStatus, 1000);
    }

    async function togglePauseQueue() {
      const secret = document.getElementById('bot-secret').value.trim();
      const currentText = document.getElementById('btn-pause-queue').textContent;
      const willPause = !currentText.includes('Lanjutkan');
      await fetch('/api/queue/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bot-secret': secret },
        body: JSON.stringify({ paused: willPause })
      });
      pollStatus();
    }

    async function clearQueue() {
      if (!confirm('Hapus semua antrean pesan yang belum terkirim?')) return;
      const secret = document.getElementById('bot-secret').value.trim();
      await fetch('/api/queue/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bot-secret': secret }
      });
      pollStatus();
    }

    async function sendTestCoupon() {
      const phone = document.getElementById('test-phone').value.trim();
      const name = document.getElementById('test-name').value.trim() || 'Nabila Putri';
      const secret = document.getElementById('bot-secret').value.trim();
      const notice = document.getElementById('test-notice');
      const btn = document.getElementById('btn-test');

      if (!phone) return alert('Masukkan nomor WhatsApp tujuan tes terlebih dahulu!');
      btn.disabled = true;
      btn.textContent = '⏳ Merender & Mengirim E-Kupon...';
      notice.style.display = 'none';

      try {
        const res = await fetch('/api/send-coupon', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-bot-secret': secret },
          body: JSON.stringify({
            ticket: {
              ticket_code: 'GLR-8492',
              customer_name: name,
              class_name: 'XI-G',
              wa_number: phone,
              total_price: 35000,
              payment_method: 'TRANSFER',
              payment_status: 'LUNAS',
              items: [
                { name: 'Cireng Ayam Suwir Pedas', qty: 2, price: 8000 },
                { name: 'Chicken Katsu Saus Kari', qty: 1, price: 12000 },
                { name: 'Es Kuwut Segar Bali', qty: 2, price: 3500 }
              ]
            }
          })
        });
        const data = await res.json();
        notice.style.display = 'block';
        if (res.ok && data.status === 'success') {
          notice.style.background = '#EAF1E4';
          notice.style.color = '#3F5B30';
          notice.textContent = '✅ ' + data.message;
        } else {
          notice.style.background = '#FDE8E8';
          notice.style.color = '#C53030';
          notice.textContent = '❌ ' + (data.message || 'Gagal mengirim E-Kupon');
        }
        pollStatus();
      } catch (err) {
        notice.style.display = 'block';
        notice.style.background = '#FDE8E8';
        notice.style.color = '#C53030';
        notice.textContent = '❌ Gagal menghubungi server bot.';
      } finally {
        btn.disabled = false;
        btn.textContent = '🚀 Kirim Contoh E-Kupon HD ke WA Sekarang';
      }
    }

    pollStatus();
    setInterval(pollStatus, 3000);
  </script>
</body>
</html>`);
});

// ============================================================================
// 7. AUTO SELF-PING KEEP-ALIVE (OPSIONAL JIKA PUBLIC_BOT_URL DISET)
// ============================================================================
function startSelfKeepAlive() {
  const selfUrl = String(process.env.PUBLIC_BOT_URL || '').trim().replace(/\/+$/, '');
  if (!selfUrl) return;

  console.log(`🔄 [Keep-Alive] Self-ping aktif setiap 8 menit ke: ${selfUrl}/ping`);
  setInterval(async () => {
    try {
      await fetch(`${selfUrl}/ping`);
    } catch {}
  }, 8 * 60 * 1000);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log('==============================================================');
  console.log(`🚀 GLORIUS WA BOT SERVER AKTIF DI: http://localhost:${PORT}`);
  console.log(`🔑 WA_BOT_SECRET: ${BOT_SECRET}`);
  console.log('==============================================================');
  startWhatsAppBot();
  startSelfKeepAlive();
});
