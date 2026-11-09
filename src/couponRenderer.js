import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import QRCode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COUPON_WIDTH = 1344;
const COUPON_HEIGHT = 630;
const TEMPLATE_PATH = path.resolve(__dirname, '../assets/kupon-bazar-template.jpg');

let cachedTemplateImage = null;

async function getTemplateImage() {
  if (cachedTemplateImage) return cachedTemplateImage;
  try {
    if (fs.existsSync(TEMPLATE_PATH)) {
      const buf = fs.readFileSync(TEMPLATE_PATH);
      cachedTemplateImage = await loadImage(buf);
      return cachedTemplateImage;
    }
  } catch (err) {
    console.warn('[CouponRenderer] Gagal memuat template gambar kupon:', err?.message);
  }
  return null;
}

export function normalizeTicketCode(raw) {
  const cleaned = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');
  if (!cleaned) return 'GLR-000';
  if (/^\d+$/.test(cleaned)) return `GLR-${cleaned}`;
  return cleaned;
}

export function createSignedQRPayload(ticketCode, totalPrice, secretKey) {
  const code = normalizeTicketCode(ticketCode);
  const price = Math.round(Number(totalPrice || 0));
  const secret =
    secretKey ||
    process.env.QR_SECRET_KEY ||
    'GLORIUS_XI_G_BULAN_BAHASA_2026_SMAN2TANGGUL';
  const message = `${code}:${price}`;
  const sig = crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
  return `GLORIUS|${code}|${price}|${sig}`;
}

export function formatIDR(amount) {
  const num = Math.round(Number(amount || 0));
  return `Rp ${num.toLocaleString('id-ID')}`;
}

function fitCanvasText(ctx, text, maxWidth) {
  const str = String(text || '');
  if (ctx.measureText(str).width <= maxWidth) return str;
  let truncated = str;
  while (truncated.length > 3 && ctx.measureText(`${truncated}…`).width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}…`;
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * Merender gambar E-Kupon Digital Stand Bazar Glorius (1344 x 630 JPEG Buffer)
 * Identik 100% dengan komponen ReceiptifyVoucher di Web Utama.
 */
export async function renderCouponJpegBuffer(ticket) {
  const code = normalizeTicketCode(ticket.ticket_code || 'GLR-000');
  const customerName = String(ticket.customer_name || 'Pelanggan Glorius').trim();
  const className = String(ticket.class_name || 'XI-G').trim();
  const totalPrice = Math.round(Number(ticket.total_price || 0));
  const paymentMethod = String(ticket.payment_method || 'COD').toUpperCase();
  const paymentStatus = String(ticket.payment_status || 'PENDING').toUpperCase();
  const isCollected = Boolean(ticket.is_collected);
  const items = Array.isArray(ticket.items) ? ticket.items : [];

  const qrString =
    ticket.qr_string || createSignedQRPayload(code, totalPrice);

  const qrPngBuffer = await QRCode.toBuffer(qrString, {
    type: 'png',
    errorCorrectionLevel: 'M',
    width: 320,
    margin: 2,
    color: { dark: '#1F2D18', light: '#FFFFFF' },
  });

  const [bgImg, qrImg] = await Promise.all([
    getTemplateImage(),
    loadImage(qrPngBuffer),
  ]);

  const canvas = createCanvas(COUPON_WIDTH, COUPON_HEIGHT);
  const ctx = canvas.getContext('2d');

  // 1. Gambar Background Template Kupon (1344 x 630)
  if (bgImg) {
    ctx.drawImage(bgImg, 0, 0, COUPON_WIDTH, COUPON_HEIGHT);
  } else {
    const grad = ctx.createLinearGradient(0, 0, COUPON_WIDTH, COUPON_HEIGHT);
    grad.addColorStop(0, '#5B7E48');
    grad.addColorStop(1, '#4E321D');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, COUPON_WIDTH, COUPON_HEIGHT);

    drawRoundedRect(ctx, 52, 298, 723, 304, 28);
    ctx.fillStyle = 'rgba(251, 249, 244, 0.92)';
    ctx.fill();

    ctx.fillStyle = '#301C10';
    ctx.font = 'bold 26px "Segoe UI", "Arial", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('Stand Bazar : GLORIUS (XI-G)', 92, 338);
    ctx.fillText('Pesanan        :', 92, 404);
    ctx.fillText('Nama Pemesan :', 172, 561);
  }

  // 2. Kode Pesanan di Ujung Seberang dari Nama Stand (x=584..760, y=314..360)
  const badgeX = 584;
  const badgeY = 314;
  const badgeW = 176;
  const badgeH = 46;

  ctx.save();
  drawRoundedRect(ctx, badgeX, badgeY, badgeW, badgeH, 12);
  ctx.fillStyle = 'rgba(78, 50, 29, 0.94)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.78)';
  ctx.stroke();

  ctx.fillStyle = '#FFF9EB';
  ctx.font = 'bold 22px "Consolas", "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    fitCanvasText(ctx, `#${code}`, badgeW - 16),
    badgeX + badgeW / 2,
    badgeY + badgeH / 2 + 1
  );
  ctx.restore();

  // 3. Isi Pesanan di Sebelah "Pesanan :" (x=332..756, y=388..524)
  const maxItemTextWidth = 420;
  const startX = 332;

  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#301C10';

  if (items.length === 0) {
    ctx.font = 'bold 21px "Segoe UI", "Arial", sans-serif';
    ctx.fillText('• Pesanan Pre-Order Stand Glorius', startX, 390);
  } else if (items.length <= 3) {
    ctx.font = 'bold 21px "Segoe UI", "Arial", sans-serif';
    let yCursor = 389;
    for (const item of items) {
      const line = fitCanvasText(ctx, `• ${item.qty}x ${item.name}`, maxItemTextWidth);
      ctx.fillText(line, startX, yCursor);
      yCursor += 31;
    }
  } else {
    ctx.font = 'bold 19px "Segoe UI", "Arial", sans-serif';
    const displayItems = items.slice(0, 3);
    let yCursor = 387;
    for (const item of displayItems) {
      const line = fitCanvasText(ctx, `• ${item.qty}x ${item.name}`, maxItemTextWidth);
      ctx.fillText(line, startX, yCursor);
      yCursor += 25;
    }
    const rest = items.slice(3);
    const restSummary = rest.map((r) => `${r.qty}x ${r.name}`).join(', ');
    const moreLine = fitCanvasText(
      ctx,
      `• +${rest.length} lainnya: ${restSummary}`,
      maxItemTextWidth
    );
    ctx.fillStyle = '#5B3E2B';
    ctx.fillText(moreLine, startX, yCursor);
  }

  // Pill Total Harga & Status Bayar
  const payStatusLabel =
    paymentStatus === 'LUNAS'
      ? `LUNAS (${paymentMethod || 'QRIS'})`
      : paymentMethod === 'TRANSFER'
      ? 'TRANSFER / QRIS'
      : 'BAYAR DI STAND (COD)';

  const totalPillY = 490;
  const totalPillH = 34;
  drawRoundedRect(ctx, startX, totalPillY, 424, totalPillH, 8);
  ctx.fillStyle = 'rgba(91, 126, 72, 0.18)';
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = 'rgba(91, 126, 72, 0.62)';
  ctx.stroke();

  ctx.fillStyle = '#335224';
  ctx.font = 'bold 17px "Segoe UI", "Arial", sans-serif';
  ctx.textBaseline = 'middle';
  const summaryText = fitCanvasText(
    ctx,
    `Total: ${formatIDR(totalPrice)}  •  ${payStatusLabel}`,
    402
  );
  ctx.fillText(summaryText, startX + 11, totalPillY + totalPillH / 2 + 1);
  ctx.restore();

  // 4. Nama Pemesan & Kelas di Sebelah "Nama Pemesan :" (x=452..758, y=561)
  ctx.save();
  ctx.fillStyle = '#301C10';
  ctx.font = 'bold 25px "Segoe UI", "Arial", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const fullCustomer =
    className && className !== '-'
      ? `${customerName} (${className})`
      : customerName;
  ctx.fillText(fitCanvasText(ctx, fullCustomer, 306), 452, 561);
  ctx.restore();

  // 5. Panel Kode QR di Bagian Paling Sebelah Kanan (x=982..1312, y=68..562)
  const panelX = 982;
  const panelY = 68;
  const panelW = 330;
  const panelH = 494;
  const panelCenterX = panelX + panelW / 2;

  ctx.save();
  drawRoundedRect(ctx, panelX + 5, panelY + 7, panelW, panelH, 26);
  ctx.fillStyle = 'rgba(35, 22, 12, 0.28)';
  ctx.fill();

  drawRoundedRect(ctx, panelX, panelY, panelW, panelH, 26);
  ctx.fillStyle = 'rgba(253, 250, 242, 0.96)';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(78, 50, 29, 0.88)';
  ctx.stroke();

  drawRoundedRect(ctx, panelX + 10, panelY + 10, panelW - 20, panelH - 20, 20);
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = 'rgba(91, 126, 72, 0.45)';
  ctx.stroke();

  drawRoundedRect(ctx, panelX + 26, panelY + 22, panelW - 52, 36, 18);
  ctx.fillStyle = '#5B7E48';
  ctx.fill();

  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 17px "Segoe UI", "Arial", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('E-KUPON RESMI XI-G', panelCenterX, panelY + 40);

  const qrSize = 262;
  const qrBoxY = panelY + 74;
  drawRoundedRect(
    ctx,
    panelCenterX - qrSize / 2 - 8,
    qrBoxY - 8,
    qrSize + 16,
    qrSize + 16,
    16
  );
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(78, 50, 29, 0.24)';
  ctx.stroke();

  if (qrImg) {
    ctx.drawImage(qrImg, panelCenterX - qrSize / 2, qrBoxY, qrSize, qrSize);
  }

  ctx.fillStyle = '#4E321D';
  ctx.font = 'bold 24px "Consolas", "Courier New", monospace';
  ctx.fillText(code, panelCenterX, qrBoxY + qrSize + 31);

  const statusBoxY = qrBoxY + qrSize + 50;
  drawRoundedRect(ctx, panelX + 26, statusBoxY, panelW - 52, 34, 10);
  if (isCollected) {
    ctx.fillStyle = '#FDE8E8';
    ctx.fill();
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = 'rgba(197, 48, 48, 0.55)';
    ctx.stroke();
    ctx.fillStyle = '#C53030';
    ctx.font = 'bold 15px "Segoe UI", "Arial", sans-serif';
    ctx.fillText('SUDAH DIAMBIL DI STAND', panelCenterX, statusBoxY + 17);
  } else {
    ctx.fillStyle = '#EAF1E4';
    ctx.fill();
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = 'rgba(91, 126, 72, 0.72)';
    ctx.stroke();
    ctx.fillStyle = '#4A683A';
    ctx.font = 'bold 15px "Segoe UI", "Arial", sans-serif';
    ctx.fillText('SIAP DIAMBIL DI STAND', panelCenterX, statusBoxY + 17);
  }

  ctx.fillStyle = '#7A6454';
  ctx.font = 'bold 14px "Segoe UI", "Arial", sans-serif';
  ctx.fillText('Tunjukkan QR ini di Meja Stand XI-G', panelCenterX, panelY + panelH - 25);
  ctx.restore();

  return canvas.toBuffer('image/jpeg', 92);
}

/**
 * Membangun teks caption WhatsApp resmi saat pengiriman E-Kupon
 */
export function buildCouponCaption(ticket, webBaseUrl) {
  const code = normalizeTicketCode(ticket.ticket_code || 'GLR-000');
  const customerName = String(ticket.customer_name || 'Pelanggan').trim();
  const className = String(ticket.class_name || 'XI-G').trim();
  const totalPrice = Math.round(Number(ticket.total_price || 0));
  const paymentMethod = String(ticket.payment_method || 'COD').toUpperCase();
  const paymentStatus = String(ticket.payment_status || 'PENDING').toUpperCase();
  const items = Array.isArray(ticket.items) ? ticket.items : [];

  const itemLines =
    items.length > 0
      ? items
          .map(
            (i) =>
              `• ${i.qty}x ${i.name} (${formatIDR(Number(i.qty || 1) * Number(i.price || 0))})`
          )
          .join('\n')
      : '• Pesanan Stand Bazar Glorius';

  const statusText =
    paymentStatus === 'LUNAS'
      ? `✅ LUNAS (${paymentMethod})`
      : paymentMethod === 'TRANSFER'
      ? '⏳ TRANSFER / QRIS (Menunggu Verifikasi)'
      : '💵 BAYAR DI STAND (COD)';

  const baseUrl = String(
    webBaseUrl || process.env.PUBLIC_WEB_URL || 'https://bazaar-glorius.vercel.app'
  ).replace(/\/+$/, '');
  const couponUrl = `${baseUrl}/kupon/${encodeURIComponent(code)}`;

  return (
    `🎫 *E-KUPON RESMI STAND BAZAR GLORIUS (XI-G)*\n` +
    `_Bulan Bahasa SMAN 2 Tanggul_\n\n` +
    `Halo *${customerName}* (${className})! 👋\n` +
    `Terima kasih sudah memesan di Stand Bazar *GLORIUS (XI-G)*. Pesananmu telah terdaftar resmi di sistem kami. Berikut rincian E-Kupon digitalmu:\n\n` +
    `📌 *Kode Kupon:* #${code}\n` +
    `💳 *Status Bayar:* ${statusText}\n\n` +
    `🍴 *Rincian Pesanan:*\n` +
    `${itemLines}\n` +
    `────────────────────\n` +
    `💰 *Total Harga: ${formatIDR(totalPrice)}*\n\n` +
    `📥 *Unduh E-Kupon (JPG / PDF):*\n` +
    `${couponUrl}\n\n` +
    `📋 *PANDUAN PENGGUNAAN KUPON:*\n` +
    `1. Simpan gambar E-Kupon di atas ke galeri foto HP kamu.\n` +
    `2. Datang ke meja kasir Stand XI-G (Glorius) saat jam istirahat/bazar berlangsung.\n` +
    `3. Tunjukkan gambar kupon ini agar *QR Code* di sisi kanan dapat di-scan oleh petugas stand.\n` +
    `4. Setelah verifikasi berhasil, hidangan lezat pesananmu akan langsung diserahkan!\n\n` +
    `⚠️ *PERINGATAN PENTING:*\n` +
    `• *WAJIB MEMBAWA HANDPHONE (HP)* saat pengambilan pesanan untuk menunjukkan QR Code kupon digital ini.\n` +
    `• Pastikan layar HP cukup terang saat di-scan oleh kasir stand.\n` +
    `• Jika HP berhalangan dibawa ke sekolah, kamu bisa mencatat *Kode Kupon #${code}* atau mencetak kupon fisik (PDF/kertas).\n\n` +
    `_Sampai jumpa di Stand XI-G! Jangan lupa bawa HP-mu ya!_ ✨🙌`
  );
}

export function buildBoothCallMessage(ticket, webBaseUrl) {
  const code = normalizeTicketCode(ticket.ticket_code || 'GLR-000');
  const customerName = String(ticket.customer_name || 'Pelanggan').trim();
  const className = String(ticket.class_name || 'XI-G').trim();
  const totalPrice = Math.round(Number(ticket.total_price || 0));
  const paymentStatus = String(ticket.payment_status || 'PENDING').toUpperCase();
  const baseUrl = String(
    webBaseUrl || process.env.PUBLIC_WEB_URL || 'https://bazaar-glorius.vercel.app'
  ).replace(/\/+$/, '');

  return (
    `🔔 *PANGGILAN PENGAMBILAN PESANAN — STAND GLORIUS (XI-G)*\n\n` +
    `Halo *${customerName}* (${className})! 👋\n` +
    `Pesanan Pre-Order kamu dengan kode *#${code}* sudah *SIAP DIAMBIL* di meja Stand Bazar Glorius (XI-G) sekarang! 🍱✨\n\n` +
    `📌 *Kode Kupon:* #${code}\n` +
    `💰 *Total:* ${formatIDR(totalPrice)} (${paymentStatus === 'LUNAS' ? 'SUDAH LUNAS' : 'Bayar saat ambil'})\n` +
    `🎫 *Buka QR Kupon:* ${baseUrl}/kupon/${encodeURIComponent(code)}\n\n` +
    `_Yuk segera merapat ke Stand XI-G selagi masih hangat & segar!_ 🙌`
  );
}

export function buildClaimedReceiptMessage(ticket) {
  const code = normalizeTicketCode(ticket.ticket_code || 'GLR-000');
  const customerName = String(ticket.customer_name || 'Pelanggan').trim();
  const className = String(ticket.class_name || 'XI-G').trim();
  const totalPrice = Math.round(Number(ticket.total_price || 0));

  return (
    `✅ *BUKTI SERAH TERIMA PESANAN — STAND GLORIUS (XI-G)*\n\n` +
    `Terima kasih banyak *${customerName}* (${className})! 🙏✨\n` +
    `Kupon *#${code}* (Total: *${formatIDR(totalPrice)}*) telah berhasil di-scan dan pesanan sudah diserahkan di meja kasir Stand XI-G.\n\n` +
    `_Selamat menikmati hidangan dari Kelas XI-G (Glorius)!_ 🍽️🌿`
  );
}

export function buildOfficialReceiptMessage(receipt, webBaseUrl) {
  const invoiceId = normalizeTicketCode(receipt.invoice_id || receipt.ticket_code || 'INV-000');
  const customerName = String(receipt.customer_name || 'Pelanggan').trim();
  const className = String(receipt.class_name || '').trim();
  const cashierName = String(receipt.cashier_name || 'Kasir Stand Glorius').trim();
  const totalPrice = Math.round(Number(receipt.total_amount || receipt.total_price || 0));
  const paidAmount = Math.round(Number(receipt.paid_amount || totalPrice));
  const changeAmount = Math.max(0, Number(receipt.change_amount || (paidAmount - totalPrice)));
  const paymentMethod = String(receipt.payment_method || 'TUNAI').toUpperCase();
  const paymentStatus = String(receipt.payment_status || 'LUNAS').toUpperCase();
  const items = Array.isArray(receipt.items) ? receipt.items : [];

  const nowWib = receipt.created_at || new Date().toLocaleString('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Jakarta'
  });

  const itemLines = items.length > 0
    ? items.map(i => `• ${i.qty}x ${i.name} (${formatIDR(Number(i.qty || 1) * Number(i.price || 0))})`).join('\n')
    : '• Transaksi Menu Stand Bazar';

  const baseUrl = String(
    webBaseUrl || process.env.PUBLIC_WEB_URL || 'https://bazaar-glorius.vercel.app'
  ).replace(/\/+$/, '');
  const receiptUrl = `${baseUrl}/nota/${encodeURIComponent(invoiceId)}`;

  return (
    `🧾 *NOTA RESMI STAND BAZAR GLORIUS (XI-G)*\n` +
    `_Bulan Bahasa SMAN 2 Tanggul_\n` +
    `──────────────────────────\n` +
    `No. Nota   : *#${invoiceId}*\n` +
    `Waktu      : ${nowWib} WIB\n` +
    `Kasir      : ${cashierName}\n` +
    (customerName && customerName !== 'Pelanggan' ? `Pelanggan  : *${customerName}*${className ? ` (${className})` : ''}\n` : '') +
    `──────────────────────────\n` +
    `*RINCIAN TRANSAKSI:*\n` +
    `${itemLines}\n` +
    `──────────────────────────\n` +
    `💰 *Total Belanja : ${formatIDR(totalPrice)}*\n` +
    `💳 Metode Bayar  : ${paymentMethod}\n` +
    (paymentMethod === 'TUNAI' || paymentMethod === 'CASH'
      ? `💵 Diterima      : ${formatIDR(paidAmount)}\n` +
        `🪙 Kembalian     : ${formatIDR(changeAmount)}\n`
      : '') +
    `📊 Status        : ✅ ${paymentStatus}\n` +
    `──────────────────────────\n` +
    `📥 *Buka Nota Digital & Cetak:*\n` +
    `${receiptUrl}\n\n` +
    `_Terima kasih telah berbelanja di Stand Bazar Glorius XI-G! Selamat menikmati hidangan kami._ ✨🙌`
  );
}
