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
  normalizeTicketCode,
} from './couponRenderer.js';

const logger = pino({ level: 'silent' });
const AUTH_DIR = path.resolve(process.env.WA_AUTH_DIR || './auth_info_baileys');

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
// Antrean pengiriman jika bot sedang reconnect sesaat
const pendingQueue = [];

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
    logs: messageLogs.slice(0, 40),
  };
}

async function flushPendingQueue() {
  if (connectionState !== 'CONNECTED' || !sock || pendingQueue.length === 0) return;
  console.log(`[WA-Bot] Memproses ${pendingQueue.length} antrean pesan tertunda...`);

  while (pendingQueue.length > 0 && connectionState === 'CONNECTED') {
    const job = pendingQueue.shift();
    if (!job) break;
    try {
      await job.execute();
    } catch (err) {
      console.error('[WA-Bot] Gagal memproses antrean:', err?.message);
    }
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
      keepAliveIntervalMs: 25000,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
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
        flushPendingQueue();
      }

      if (connection === 'close') {
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
  const webBaseUrl = options.webBaseUrl || process.env.PUBLIC_WEB_URL;

  const executeSend = async () => {
    const jpgBuffer = await renderCouponJpegBuffer(ticket);
    const caption = buildCouponCaption(ticket, webBaseUrl);

    await sock.sendMessage(target.jid, {
      image: jpgBuffer,
      caption,
      mimetype: 'image/jpeg',
    });

    pushLog({
      type: 'COUPON_IMAGE',
      ticket_code: code,
      customer_name: ticket.customer_name || 'Pelanggan',
      phone: target.phone,
      status: 'SENT',
      detail: `E-Kupon HD (${Math.round(jpgBuffer.byteLength / 1024)} KB) terkirim`,
    });
  };

  if (connectionState !== 'CONNECTED' || !sock) {
    pendingQueue.push({ execute: executeSend });
    pushLog({
      type: 'COUPON_IMAGE',
      ticket_code: code,
      customer_name: ticket.customer_name || 'Pelanggan',
      phone: target.phone,
      status: 'QUEUED',
      detail: 'Dimasukkan ke antrean (menunggu koneksi WA aktif)',
    });
    return {
      success: true,
      queued: true,
      phone: target.phone,
      message: 'Bot sedang menyambung ulang, E-Kupon dimasukkan ke antrean otomatis.',
    };
  }

  try {
    await executeSend();
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
  const includeCouponImage = Boolean(payload.include_image);

  const executeNotif = async () => {
    let textMessage = String(payload.custom_message || '').trim();
    if (!textMessage) {
      if (notifType === 'CLAIMED') {
        textMessage = buildClaimedReceiptMessage(ticket);
      } else {
        textMessage = buildBoothCallMessage(ticket, payload.webBaseUrl);
      }
    }

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
  };

  if (connectionState !== 'CONNECTED' || !sock) {
    pendingQueue.push({ execute: executeNotif });
    return {
      success: true,
      queued: true,
      phone: target.phone,
      message: 'Notifikasi masuk antrean pengiriman otomatis.',
    };
  }

  await executeNotif();
  return {
    success: true,
    queued: false,
    phone: target.phone,
    message: `Notifikasi (${notifType}) berhasil dikirim ke ${target.phone}!`,
  };
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
