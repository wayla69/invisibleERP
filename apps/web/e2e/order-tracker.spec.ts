import { test, expect, type Page } from '@playwright/test';

/**
 * Public order tracker (takeaway/delivery) — interactive smoke test.
 * No login: the page polls the public GET /api/order/t/:token endpoint and shows the fulfillment
 * timeline + bill, then pays via PromptPay. The backend is fully stubbed via route interception.
 */

const STATUS = {
  order_no: 'DIN-20260626-001', channel: 'web', fulfillment_type: 'takeaway', fulfillment_status: 'preparing',
  status: 'sent_to_kitchen', waited_min: 2, ready_in_min: 8,
  items: [{ item_id: 1, name: 'ผัดไทยกุ้งสด', qty: 1, kds_status: 'preparing', status_th: 'กำลังทำ', amount: 80 }],
  bill: { subtotal: 80, vat: 5.6, delivery_fee: 0, total: 85.6 },
};

async function stub(page: Page) {
  let paid = false;
  await page.route('**/api/order/t/**', async (route) => {
    const url = route.request().url();
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.endsWith('/pay')) return json({ payment_no: 'PAY-1', qr_image: 'data:image/png;base64,iVBORw0KGgo=', total: 85.6, mock_settle: false });
    if (url.endsWith('/confirm')) { paid = true; return json({ paid: true }); }
    return json(paid ? { ...STATUS, fulfillment_status: 'ready' } : STATUS);
  });
}

test('a takeaway customer tracks the order and pays via PromptPay', async ({ page }) => {
  await stub(page);
  await page.goto('/track/e2e-track-token');

  // the order + timeline render, with "กำลังเตรียม" as the active stage
  await expect(page.getByText('DIN-20260626-001')).toBeVisible();
  await expect(page.getByText('กำลังเตรียม')).toBeVisible();
  await expect(page.getByText('ผัดไทยกุ้งสด', { exact: false })).toBeVisible();
  await expect(page.getByText('฿85.60')).toBeVisible();

  // pay online → a PromptPay QR appears → confirm → "ชำระเงินแล้ว"
  await page.getByRole('button', { name: /ชำระเงินออนไลน์/ }).click();
  await expect(page.getByAltText('PromptPay QR')).toBeVisible();
  await page.getByRole('button', { name: /ฉันชำระเงินแล้ว/ }).click();
  await expect(page.getByText('ชำระเงินแล้ว ขอบคุณ', { exact: false })).toBeVisible();
});
