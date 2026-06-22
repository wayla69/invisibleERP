import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Item images — stored as data-URLs in-DB (no object storage configured). Global, like `items`.
export const itemImages = pgTable('item_images', {
  itemId: text('item_id').primaryKey(),
  imageKey: text('image_key'),
  dataUrl: text('data_url'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  updatedBy: text('updated_by'),
});
