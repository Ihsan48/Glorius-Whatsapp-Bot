import fs from 'node:fs';
import path from 'node:path';
import { renderCouponJpegBuffer, buildCouponCaption } from './couponRenderer.js';

async function run() {
  const sampleTicket = {
    ticket_code: 'GLR-8492',
    customer_name: 'Nabila Putri',
    class_name: 'XI-G',
    total_price: 35000,
    payment_method: 'TRANSFER',
    payment_status: 'LUNAS',
    is_collected: false,
    items: [
      { name: 'Cireng Ayam Suwir Pedas', qty: 2, price: 8000 },
      { name: 'Chicken Katsu Saus Kari', qty: 1, price: 12000 },
      { name: 'Es Kuwut Segar Bali', qty: 2, price: 3500 },
    ],
  };

  const t0 = Date.now();
  const buffer = await renderCouponJpegBuffer(sampleTicket);
  const elapsed = Date.now() - t0;

  const outPath = path.resolve('./assets/sample-rendered-coupon.jpg');
  fs.writeFileSync(outPath, buffer);
  console.log(`✅ E-Kupon berhasil dirender dalam ${elapsed}ms (${buffer.byteLength} bytes) -> ${outPath}`);
  console.log('\n--- PREVIEW CAPTION WA ---\n');
  console.log(buildCouponCaption(sampleTicket, 'https://bazaar-glorius.vercel.app'));
}

run().catch((err) => {
  console.error('❌ Gagal merender kupon:', err);
  process.exit(1);
});
