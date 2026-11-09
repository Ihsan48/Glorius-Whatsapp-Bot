import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} from '@whiskeysockets/baileys';
import {
  renderCouponJpegBuffer,
  buildCouponCaption,
  buildBoothCallMessage,
  buildClaimedReceiptMessage,
  buildOfficialReceiptMessage,
  normalizeTicketCode,
} from './couponRenderer.js';

const logger = pino({ level: 'silent' });
const DATA_DIR = path.resolve(process.env.WA_DATA_DIR || './data');
const AUTH_DIR = path.resolve(process.env.WA_AUTH_DIR || path.join(DATA_DIR, 'auth_info_baileys'));
const QUEUE_FILE = path.resolve(path.join(DATA_DIR, 'pending_queue.json'));

let sock = null;
let connectionState = 'DISCONNECTED'; // 'DISCONNECTED' | 'CONNECTING' | 'WAITING_QR' | 'CONNECTED'
let currentQrString = null;
let currentQrDataUrl = null;
let latestPairingCode = null;
let connectedUser = null;
let reconnectTimer = null;
let isStarting = false;
const startedAt = Date.now();

// Riwayat pengiriman pesan (maksimal 100 entri terakhir di memori)
const messageLogs = [];
// Antrean pengiriman persisten di disk
const pendingQueue = [];
let isProcessingQueue = false;
let isQueuePaused = false;
let heartbeatInterval = null;

// Konfigurasi Keamanan Anti-Spam (Human-Like Pacing)
const SAFE_CONFIG = {
  MIN_DELAY_MS: 4000,       // Jeda minimal antar pesan (4 detik)
  MAX_DELAY_MS: 7500,       // Jeda maksimal antar pesan (7.5 detik)
  COMPOSING_DELAY_MS: 1800, // Waktu simulasi "sedang mengetik" (1.8 detik)
  MAX_QUEUE_TTL_MS: 4 * 60 * 60 * 1000, // Batas usia pesan dalam antrean: 4 jam (cegah blast pesan basi)
};

function ensureDataDirectories() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
}

function saveQueueToDisk() {
  try {
    ensureDataDirectories();
    const serializableQueue = pendingQueue.map((item) => ({
      id: item.id || `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      action: item.action || 'COUPON',
      ticket: item.ticket || null,
      payload: item.payload || null,
      options: item.options || {},
      type: item.type || 'COUPON_IMAGE',
      ticketCode: item.ticketCode || item.ticket?.ticket_code || '-',
      customerName: item.customerName || item.ticket?.customer_name || 'Pelanggan',
      phone: item.phone || '-',
      createdAt: item.createdAt || Date.now(),
    }));
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(serializableQueue, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[WA-Bot] Gagal menyimpan antrean ke disk:', err?.message);
  }
}

function loadQueueFromDisk() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      const raw = fs.readFileSync(QUEUE_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.log(`📦 [WA-Bot] Memuat ${parsed.length} antrean tersimpan dari disk (${QUEUE_FILE})...`);
        for (const item of parsed) {
          // Buat closure eksekusi ulang dari data tiket yang tersimpan
          if (item.action === 'COUPON' && item.ticket) {
            pendingQueue.push({
              ...item,
              execute: () => internalSendCoupon(item.ticket, item.options),
            });
          } else if (item.action === 'NOTIF' && item.payload) {
            pendingQueue.push({
              ...item,
              execute: () => internalSendNotification(item.payload),
            });
          } else if (item.action === 'RECEIPT' && item.receipt) {
            pendingQueue.push({
              ...item,
              execute: () => internalSendReceipt(item.receipt, item.options),
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn('[WA-Bot] Gagal membaca antrean dari disk:', err?.message);
  }
}

// Inisialisasi awal direktori dan muat antrean tersimpan saat boot
ensureDataDirectories();
loadQueueFromDisk();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRandomDelay(min = SAFE_CONFIG.MIN_DELAY_MS, max = SAFE_CONFIG.MAX_DELAY_MS) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pushLog(entry) {
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toLocaleString('id-ID', {
      dateStyle: 'short',
      timeStyle: 'medium',
    }),
    ...entry,
  };
  messageLogs.unshift(item);
  if (messageLogs.length > 100) messageLogs.pop();
  return item;
}

/**
 * Normalisasi nomor WA Indonesia ke format JID Baileys (628xxxx@s.whatsapp.net)
 */
export function formatPhoneToJid(rawPhone) {
  let digits = String(rawPhone || '').replace(/\D+/g, '');
  if (!digits || digits.length < 8) return null;

  if (digits.startsWith('0')) {
    digits = '62' + digits.slice(1);
  } else if (digits.startsWith('8')) {
    digits = '62' + digits;
  }

  if (!digits.startsWith('62') && digits.length >= 9) {
    // Biarkan jika nomor internasional valid
  }

  return {
    phone: digits,
    jid: `${digits}@s.whatsapp.net`,
  };
}

export function getBotState() {
  return {
    status: connectionState,
    connected: connectionState === 'CONNECTED',
    user: connectedUser,
    qrDataUrl: connectionState === 'WAITING_QR' ? currentQrDataUrl : null,
    pairingCode: latestPairingCode,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    queueLength: pendingQueue.length,
    isProcessingQueue,
    isQueuePaused,
    safeMode: true,
    logs: messageLogs.slice(0, 40),
  };
}

export function setQueuePauseState(paused) {
  isQueuePaused = Boolean(paused);
  if (!isQueuePaused && connectionState === 'CONNECTED') {
    triggerQueueProcessing();
  }
  return { isQueuePaused, queueLength: pendingQueue.length };
}

export function clearPendingQueue() {
  const clearedCount = pendingQueue.length;
  pendingQueue.length = 0;
  saveQueueToDisk();
  return { clearedCount };
}

/**
 * Pemroses antrean adaptif dengan Pacing & Human Presence (Anti-Ban)
 */
export async function triggerQueueProcessing() {
  if (isProcessingQueue) return;
  if (isQueuePaused) return;
  if (connectionState !== 'CONNECTED' || !sock) return;

  isProcessingQueue = true;
  console.log(`[WA-Bot] Memulai pemrosesan aman antrean (${pendingQueue.length} item tersisa)...`);

  try {
    while (pendingQueue.length > 0 && connectionState === 'CONNECTED' && !isQueuePaused) {
      const job = pendingQueue.shift();
      saveQueueToDisk();
      if (!job) break;

      // Filter pesan yang sudah kedaluwarsa (> 4 jam) agar tidak membuat kaget siswa
      if (job.createdAt && Date.now() - job.createdAt > SAFE_CONFIG.MAX_QUEUE_TTL_MS) {
        console.warn(`[WA-Bot] Mengabaikan pesan kadaluarsa tiket ${job.ticketCode || '-'}`);
        pushLog({
          type: job.type || 'EXPIRED_MESSAGE',
          ticket_code: job.ticketCode || '-',
          customer_name: job.customerName || 'Pelanggan',
          phone: job.phone || '-',
          status: 'SKIPPED',
          detail: 'Dilewati: Antrean kadaluarsa (> 4 jam) untuk mencegah spam',
        });
        continue;
      }

      try {
        await job.execute();
      } catch (err) {
        console.error(`[WA-Bot] Gagal mengeksekusi pesan ${job.ticketCode || ''}:`, err?.message);
      }

      // Berikan jeda acak manusiawi (4–7.5 detik) jika masih ada antrean berikutnya
      if (pendingQueue.length > 0 && connectionState === 'CONNECTED' && !isQueuePaused) {
        const delay = getRandomDelay();
        console.log(`⏳ [Anti-Ban Pacing] Menunggu jeda aman ${Math.round(delay / 1000)}s sebelum pesan berikutnya...`);
        await sleep(delay);
      }
    }
  } finally {
    isProcessingQueue = false;
    saveQueueToDisk();
  }
}

/**
 * Auto-responder interaktif ketika siswa chat langsung ke nomor Bot WA
 */
async function handleIncomingMessage(msg) {
  try {
    if (!msg?.message || msg.key.fromMe) return;
    const remoteJid = msg.key.remoteJid || '';
    if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') {
      return; // Abaikan pesan grup dan status WA
    }

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      '';
    const cleanText = String(text || '').trim();
    if (!cleanText) return;

    const lower = cleanText.toLowerCase();
    const webBaseUrl = String(
      process.env.PUBLIC_WEB_URL || 'https://bazaar-glorius.vercel.app'
    ).replace(/\/+$/, '');

    // 1. Perintah !ping / !status
    if (lower === '!ping' || lower === '!status') {
      const upMin = Math.floor((Date.now() - startedAt) / 60000);
      await sock.sendMessage(remoteJid, {
        text: `🤖 *BOT WA STAND GLORIUS (XI-G) AKTIF 24/7*\n⏱️ Uptime: ${upMin} menit\n🌐 Web: ${webBaseUrl}`,
      });
      return;
    }

    // 2. Perintah !menu / menu / info
    if (lower === '!menu' || lower === 'menu' || lower === 'halo' || lower === 'p' || lower === 'info') {
      await sock.sendMessage(remoteJid, {
        text:
          `🌿 *SELAMAT DATANG DI STAND BAZAR GLORIUS (XI-G)*\n` +
          `_Bulan Bahasa SMAN 2 Tanggul_\n\n` +
          `Halo! Kamu bisa memesan menu favorit Stand XI-G secara Pre-Order dan mendapatkan *E-Kupon Digital Resmi*:\n\n` +
          `🛒 *Pesan Online Sekarang:*\n${webBaseUrl}\n\n` +
          `🎫 *Cek / Ambil Ulang E-Kupon:*\nKetik kode kuponmu di chat ini (contoh: *GLR-8492* atau *!kupon GLR-8492*), maka Bot akan langsung mengirimkan gambar E-Kupon HD milikmu! ✨`,
      });
      return;
    }

    // 3. Cek Kode Kupon Otomatis (ketik "GLR-xxx" atau "!kupon GLR-xxx")
    const matchTicket = cleanText.match(/(?:!kupon\s+|cek\s+)?(GLR-\d{3,6})/i);
    if (matchTicket) {
      const requestedCode = normalizeTicketCode(matchTicket[1]);
      await sock.sendMessage(remoteJid, {
        text: `⏳ _Sedang mencari E-Kupon *#${requestedCode}* di database Stand Glorius..._`,
      });

      const apiUrl = `${webBaseUrl}/api/bazaar?action=checkTicket&code=${encodeURIComponent(requestedCode)}`;
      const res = await fetch(apiUrl);
      const json = await res.json().catch(() => null);

      if (!res.ok || !json || json.status !== 'success' || !json.data) {
        await sock.sendMessage(remoteJid, {
          text: `❌ Maaf, kupon dengan kode *#${requestedCode}* tidak ditemukan di sistem Stand Bazar Glorius (XI-G). Pastikan kode tiket sudah benar ya!`,
        });
        return;
      }

      const ord = json.data;
      let items = [];
      try {
        items =
          typeof ord.items_json === 'string'
            ? JSON.parse(ord.items_json)
            : Array.isArray(ord.items)
            ? ord.items
            : [];
      } catch {}

      const ticketPayload = {
        ...ord,
        items,
      };

      const jpgBuffer = await renderCouponJpegBuffer(ticketPayload);
      const caption = buildCouponCaption(ticketPayload, webBaseUrl);

      await sock.sendMessage(remoteJid, {
        image: jpgBuffer,
        caption,
        mimetype: 'image/jpeg',
      });

      pushLog({
        type: 'AUTO_REPLY_COUPON',
        ticket_code: requestedCode,
        customer_name: ord.customer_name || 'Siswa',
        phone: remoteJid.replace('@s.whatsapp.net', ''),
        status: 'SENT',
        detail: 'Siswa meminta E-Kupon via chat WA',
      });
    }
  } catch (err) {
    console.warn('[WA-Bot] Auto-reply warning:', err?.message);
  }
}

/**
 * Inisialisasi koneksi WebSocket WhatsApp Baileys (Auto-Reconnect 24/7)
 */
export async function startWhatsAppBot() {
  if (isStarting) return;
  isStarting = true;

  try {
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    connectionState = 'CONNECTING';
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({
      version: [2, 3000, 1043857760],
    }));

    sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: Browsers.windows('Desktop'),
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      keepAliveIntervalMs: 15000,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      retryRequestDelayMs: 2000,
      maxMsgRetryCount: 3,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connectionState = 'WAITING_QR';
        currentQrString = qr;
        currentQrDataUrl = await QRCode.toDataURL(qr, {
          errorCorrectionLevel: 'M',
          width: 340,
          margin: 2,
          color: { dark: '#1F2D18', light: '#FFFFFF' },
        });
        console.log('📱 [WA-Bot] QR Code baru siap di-scan! Buka panel web bot untuk scan QR atau gunakan Pairing Code.');
      }

      if (connection === 'open') {
        connectionState = 'CONNECTED';
        currentQrString = null;
        currentQrDataUrl = null;
        latestPairingCode = null;
        connectedUser = {
          id: sock?.user?.id || '',
          name: sock?.user?.name || 'Stand Bazar Glorius XI-G',
        };
        console.log(`✅ [WA-Bot] TERHUBUNG KE WHATSAPP sebagai: ${connectedUser.id}`);

        // Set status online di WhatsApp
        try {
          await sock.sendPresenceUpdate('available');
        } catch {}

        // Mulai background proactive heartbeat (ping socket setiap 45 detik)
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(async () => {
          if (connectionState === 'CONNECTED' && sock) {
            try {
              // Simulasi keep-alive ringan tanpa membebani chat
              await sock.sendPresenceUpdate('available');
            } catch (err) {
              console.warn('[WA-Bot] Heartbeat warning:', err?.message);
            }
          }
        }, 45000);

        // Jalankan antrean dengan pacing aman anti-ban
        triggerQueueProcessing();
      }

      if (connection === 'close') {
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }

        const statusCode =
          lastDisconnect?.error?.output?.statusCode ||
          lastDisconnect?.error?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.warn(
          `⚠️ [WA-Bot] Koneksi terputus (code: ${statusCode}). Auto-reconnect: ${shouldReconnect}`
        );

        connectionState = 'DISCONNECTED';
        currentQrString = null;
        currentQrDataUrl = null;
        connectedUser = null;

        if (statusCode === DisconnectReason.loggedOut) {
          console.log('🧹 [WA-Bot] Sesi logout terdeteksi. Membersihkan folder sesi untuk login baru...');
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch {}
        }

        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          isStarting = false;
          startWhatsAppBot();
        }, 3500);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        await handleIncomingMessage(msg);
      }
    });
  } catch (err) {
    console.error('❌ [WA-Bot] Error saat memulai Baileys:', err?.message);
    connectionState = 'DISCONNECTED';
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      isStarting = false;
      startWhatsAppBot();
    }, 5000);
  } finally {
    isStarting = false;
  }
}

/**
 * Meminta 8-Digit Pairing Code (Tanpa Scan QR Kamera)
 */
export async function requestPhonePairingCode(rawPhone) {
  const formatted = formatPhoneToJid(rawPhone);
  if (!formatted) {
    throw new Error('Nomor WhatsApp tidak valid. Gunakan format 0812xxxx atau 62812xxxx.');
  }
  if (!sock) {
    throw new Error('Socket WhatsApp sedang diinisialisasi. Tunggu beberapa detik lalu coba lagi.');
  }
  if (connectionState === 'CONNECTED') {
    throw new Error('Bot sudah terhubung ke WhatsApp!');
  }

  const code = await sock.requestPairingCode(formatted.phone);
  const prettyCode =
    code && code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
  latestPairingCode = prettyCode;
  return {
    phone: formatted.phone,
    pairingCode: prettyCode,
  };
}

/**
 * Logout / Reset Sesi WhatsApp
 */
export async function resetWhatsAppSession() {
  try {
    if (sock) {
      await sock.logout().catch(() => {});
    }
  } catch {}
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  } catch {}
  connectionState = 'DISCONNECTED';
  currentQrString = null;
  currentQrDataUrl = null;
  latestPairingCode = null;
  connectedUser = null;
  isStarting = false;
  setTimeout(() => startWhatsAppBot(), 1000);
}

/**
 * Eksekusi pengiriman E-Kupon murni
 */
async function internalSendCoupon(ticket, options = {}) {
  const target = formatPhoneToJid(ticket?.wa_number || options?.phone);
  if (!target) return;
  const code = normalizeTicketCode(ticket.ticket_code || 'GLR-000');
  const webBaseUrl = options.webBaseUrl || process.env.PUBLIC_WEB_URL;

  try {
    await sock.sendPresenceUpdate('composing', target.jid);
    await sleep(SAFE_CONFIG.COMPOSING_DELAY_MS);
  } catch {}

  const jpgBuffer = await renderCouponJpegBuffer(ticket);
  const caption = buildCouponCaption(ticket, webBaseUrl);

  await sock.sendMessage(target.jid, {
    image: jpgBuffer,
    caption,
    mimetype: 'image/jpeg',
  });

  try {
    await sock.sendPresenceUpdate('paused', target.jid);
  } catch {}

  pushLog({
    type: 'COUPON_IMAGE',
    ticket_code: code,
    customer_name: ticket.customer_name || 'Pelanggan',
    phone: target.phone,
    status: 'SENT',
    detail: `E-Kupon HD (${Math.round(jpgBuffer.byteLength / 1024)} KB) terkirim`,
  });
}

/**
 * Eksekusi pengiriman Notifikasi murni
 */
async function internalSendNotification(payload) {
  const target = formatPhoneToJid(payload?.wa_number || payload?.phone);
  if (!target) return;
  const notifType = String(payload.type || 'CALL_BOOTH').toUpperCase();
  const ticket = payload.ticket || payload;
  const code = normalizeTicketCode(ticket.ticket_code || 'GLR-000');
  const includeCouponImage = Boolean(payload.include_image);

  let textMessage = String(payload.custom_message || '').trim();
  if (!textMessage) {
    if (notifType === 'CLAIMED') {
      textMessage = buildClaimedReceiptMessage(ticket);
    } else {
      textMessage = buildBoothCallMessage(ticket, payload.webBaseUrl);
    }
  }

  try {
    await sock.sendPresenceUpdate('composing', target.jid);
    await sleep(1500);
  } catch {}

  if (includeCouponImage) {
    const jpgBuffer = await renderCouponJpegBuffer(ticket);
    await sock.sendMessage(target.jid, {
      image: jpgBuffer,
      caption: textMessage,
      mimetype: 'image/jpeg',
    });
  } else {
    await sock.sendMessage(target.jid, {
      text: textMessage,
    });
  }

  try {
    await sock.sendPresenceUpdate('paused', target.jid);
  } catch {}

  pushLog({
    type: notifType,
    ticket_code: code,
    customer_name: ticket.customer_name || 'Pelanggan',
    phone: target.phone,
    status: 'SENT',
    detail:
      notifType === 'CLAIMED'
        ? 'Notifikasi bukti klaim terkirim'
        : 'Panggilan ambil pesanan di stand terkirim',
  });
}

/**
 * Eksekusi pengiriman Nota Resmi murni
 */
async function internalSendReceipt(receipt, options = {}) {
  const target = formatPhoneToJid(receipt?.customer_phone || receipt?.wa_number || options?.phone);
  if (!target) return;
  const invoiceId = normalizeTicketCode(receipt.invoice_id || receipt.ticket_code || 'INV-000');
  const webBaseUrl = options.webBaseUrl || process.env.PUBLIC_WEB_URL;
  const textMessage = buildOfficialReceiptMessage(receipt, webBaseUrl);

  try {
    await sock.sendPresenceUpdate('composing', target.jid);
    await sleep(SAFE_CONFIG.COMPOSING_DELAY_MS);
  } catch {}

  await sock.sendMessage(target.jid, {
    text: textMessage,
  });

  try {
    await sock.sendPresenceUpdate('paused', target.jid);
  } catch {}

  pushLog({
    type: 'RECEIPT_NOTA',
    ticket_code: invoiceId,
    customer_name: receipt.customer_name || 'Pelanggan',
    phone: target.phone,
    status: 'SENT',
    detail: `Nota Resmi #${invoiceId} terkirim via WhatsApp`,
  });
}

/**
 * Mengirim E-Kupon (Gambar HD 1344x630 + Caption Lengkap) ke Nomor WA Pembeli
 */
export async function sendOrderCouponToWA(ticket, options = {}) {
  const target = formatPhoneToJid(ticket?.wa_number || options?.phone);
  if (!target) {
    return {
      success: false,
      queued: false,
      error: 'Nomor WhatsApp pembeli kosong atau tidak valid.',
    };
  }

  const code = normalizeTicketCode(ticket.ticket_code || 'GLR-000');

  // Jika bot sedang disconnect ATAU antrean sedang aktif berjalan, masukkan ke antrean teratur
  if (connectionState !== 'CONNECTED' || !sock || isProcessingQueue || pendingQueue.length > 0) {
    pendingQueue.push({
      action: 'COUPON',
      ticket,
      options,
      execute: () => internalSendCoupon(ticket, options),
      type: 'COUPON_IMAGE',
      ticketCode: code,
      customerName: ticket.customer_name || 'Pelanggan',
      phone: target.phone,
      createdAt: Date.now(),
    });
    saveQueueToDisk();

    pushLog({
      type: 'COUPON_IMAGE',
      ticket_code: code,
      customer_name: ticket.customer_name || 'Pelanggan',
      phone: target.phone,
      status: 'QUEUED',
      detail: connectionState === 'CONNECTED'
        ? `Diantrekan aman (Pacing anti-spam, antrean: #${pendingQueue.length})`
        : 'Diantrekan (menunggu koneksi WA aktif)',
    });

    if (connectionState === 'CONNECTED' && !isProcessingQueue && !isQueuePaused) {
      triggerQueueProcessing();
    }

    return {
      success: true,
      queued: true,
      phone: target.phone,
      queueLength: pendingQueue.length,
      message: connectionState === 'CONNECTED'
        ? `Pesanan masuk antrean pengiriman aman anti-spam (urutan #${pendingQueue.length}).`
        : 'Bot sedang menyambung ulang, E-Kupon dimasukkan ke antrean otomatis.',
    };
  }

  try {
    isProcessingQueue = true;
    await internalSendCoupon(ticket, options);
    return {
      success: true,
      queued: false,
      phone: target.phone,
      message: `E-Kupon #${code} berhasil dikirim ke WhatsApp ${target.phone}!`,
    };
  } catch (err) {
    pushLog({
      type: 'COUPON_IMAGE',
      ticket_code: code,
      customer_name: ticket.customer_name || 'Pelanggan',
      phone: target.phone,
      status: 'FAILED',
      detail: err?.message || 'Gagal mengirim pesan',
    });
    throw err;
  } finally {
    isProcessingQueue = false;
    if (pendingQueue.length > 0) {
      triggerQueueProcessing();
    }
  }
}

/**
 * Mengirim Notifikasi Panggilan ke Stand / Bukti Klaim / Pesan Kustom
 */
export async function sendNotificationToWA(payload) {
  const target = formatPhoneToJid(payload?.wa_number || payload?.phone);
  if (!target) {
    return {
      success: false,
      error: 'Nomor WhatsApp tujuan tidak valid.',
    };
  }

  const notifType = String(payload.type || 'CALL_BOOTH').toUpperCase();
  const ticket = payload.ticket || payload;
  const code = normalizeTicketCode(ticket.ticket_code || 'GLR-000');

  if (connectionState !== 'CONNECTED' || !sock || isProcessingQueue || pendingQueue.length > 0) {
    pendingQueue.push({
      action: 'NOTIF',
      payload,
      execute: () => internalSendNotification(payload),
      type: notifType,
      ticketCode: code,
      customerName: ticket.customer_name || 'Pelanggan',
      phone: target.phone,
      createdAt: Date.now(),
    });
    saveQueueToDisk();

    if (connectionState === 'CONNECTED' && !isProcessingQueue && !isQueuePaused) {
      triggerQueueProcessing();
    }

    return {
      success: true,
      queued: true,
      phone: target.phone,
      queueLength: pendingQueue.length,
      message: connectionState === 'CONNECTED'
        ? `Notifikasi masuk antrean aman (urutan #${pendingQueue.length}).`
        : 'Notifikasi masuk antrean pengiriman otomatis.',
    };
  }

  try {
    isProcessingQueue = true;
    await internalSendNotification(payload);
    return {
      success: true,
      queued: false,
      phone: target.phone,
      message: `Notifikasi (${notifType}) berhasil dikirim ke ${target.phone}!`,
    };
  } finally {
    isProcessingQueue = false;
    if (pendingQueue.length > 0) {
      triggerQueueProcessing();
    }
  }
}

/**
 * Mengirim Nota / Kwitansi Resmi ke Nomor WA Pembeli
 */
export async function sendReceiptToWA(receipt, options = {}) {
  const target = formatPhoneToJid(receipt?.customer_phone || receipt?.wa_number || options?.phone);
  if (!target) {
    return {
      success: false,
      queued: false,
      error: 'Nomor WhatsApp pembeli kosong atau tidak valid.',
    };
  }

  const invoiceId = normalizeTicketCode(receipt.invoice_id || receipt.ticket_code || 'INV-000');

  if (connectionState !== 'CONNECTED' || !sock || isProcessingQueue || pendingQueue.length > 0) {
    pendingQueue.push({
      action: 'RECEIPT',
      receipt,
      options,
      execute: () => internalSendReceipt(receipt, options),
      type: 'RECEIPT_NOTA',
      ticketCode: invoiceId,
      customerName: receipt.customer_name || 'Pelanggan',
      phone: target.phone,
      createdAt: Date.now(),
    });
    saveQueueToDisk();

    pushLog({
      type: 'RECEIPT_NOTA',
      ticket_code: invoiceId,
      customer_name: receipt.customer_name || 'Pelanggan',
      phone: target.phone,
      status: 'QUEUED',
      detail: connectionState === 'CONNECTED'
        ? `Diantrekan aman (Pacing anti-spam, antrean: #${pendingQueue.length})`
        : 'Diantrekan (menunggu koneksi WA aktif)',
    });

    if (connectionState === 'CONNECTED' && !isProcessingQueue && !isQueuePaused) {
      triggerQueueProcessing();
    }

    return {
      success: true,
      queued: true,
      phone: target.phone,
      queueLength: pendingQueue.length,
      message: connectionState === 'CONNECTED'
        ? `Nota #${invoiceId} masuk antrean pengiriman aman (urutan #${pendingQueue.length}).`
        : 'Bot sedang menyambung ulang, Nota dimasukkan ke antrean otomatis.',
    };
  }

  try {
    isProcessingQueue = true;
    await internalSendReceipt(receipt, options);
    return {
      success: true,
      queued: false,
      phone: target.phone,
      message: `Nota Resmi #${invoiceId} berhasil dikirim ke WhatsApp ${target.phone}!`,
    };
  } catch (err) {
    pushLog({
      type: 'RECEIPT_NOTA',
      ticket_code: invoiceId,
      customer_name: receipt.customer_name || 'Pelanggan',
      phone: target.phone,
      status: 'FAILED',
      detail: err?.message || 'Gagal mengirim nota',
    });
    throw err;
  } finally {
    isProcessingQueue = false;
    if (pendingQueue.length > 0) {
      triggerQueueProcessing();
    }
  }
}


/**
 * Mengecek apakah suatu nomor terdaftar di WhatsApp dan mengambil display/push name publiknya jika ada
 */
export async function checkWhatsAppPhoneWithProfile(rawPhone) {
  const target = formatPhoneToJid(rawPhone);
  if (!target) {
    return {
      valid: false,
      exists: false,
      message: 'Format nomor telepon tidak valid (gunakan awalan 08 / 628).',
    };
  }

  if (connectionState !== 'CONNECTED' || !sock) {
    return {
      valid: true,
      exists: null,
      phone: target.phone,
      formattedPhone: target.phone.replace(/^62/, '0'),
      pushName: null,
      message: 'Bot WhatsApp belum terhubung ke server WhatsApp.',
    };
  }

  try {
    const results = await sock.onWhatsApp(target.jid);
    const hit = Array.isArray(results) ? results.find((r) => r.exists) : null;

    if (!hit) {
      return {
        valid: true,
        exists: false,
        phone: target.phone,
        formattedPhone: target.phone.replace(/^62/, '0'),
        pushName: null,
        message: 'Nomor ini tidak memiliki akun WhatsApp aktif.',
      };
    }

    let pushName = null;
    try {
      if (typeof sock.getBusinessProfile === 'function') {
        const biz = await sock.getBusinessProfile(target.jid).catch(() => null);
        if (biz?.description) pushName = biz.description;
      }
      if (!pushName && typeof sock.fetchStatus === 'function') {
        const st = await sock.fetchStatus(target.jid).catch(() => null);
        if (st?.status) pushName = st.status;
      }
    } catch {}

    return {
      valid: true,
      exists: true,
      phone: target.phone,
      formattedPhone: target.phone.replace(/^62/, '0'),
      jid: hit.jid || target.jid,
      pushName: pushName || null,
      message: 'Nomor terverifikasi aktif di WhatsApp!',
    };
  } catch (err) {
    return {
      valid: true,
      exists: null,
      phone: target.phone,
      formattedPhone: target.phone.replace(/^62/, '0'),
      pushName: null,
      message: err?.message || 'Gagal mengecek nomor ke WhatsApp.',
    };
  }
}
