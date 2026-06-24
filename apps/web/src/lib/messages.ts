// C1 (Platform Phase 20) — UI message catalog, keyed by message id, per locale. Seeded with common chrome +
// actions for every supported locale; extend per screen as translations are added. `th` is the
// source-of-truth fallback. Pure data (no imports) so it can be split into per-locale JSON files later.
export type Lang = 'th' | 'en' | 'ms' | 'vi' | 'id';

export const MESSAGES: Record<string, Partial<Record<Lang, string>>> = {
  'common.search': { th: 'ค้นหา…', en: 'Search…', ms: 'Cari…', vi: 'Tìm…', id: 'Cari…' },
  'common.save': { th: 'บันทึก', en: 'Save', ms: 'Simpan', vi: 'Lưu', id: 'Simpan' },
  'common.cancel': { th: 'ยกเลิก', en: 'Cancel', ms: 'Batal', vi: 'Hủy', id: 'Batal' },
  'common.language': { th: 'ภาษา', en: 'Language', ms: 'Bahasa', vi: 'Ngôn ngữ', id: 'Bahasa' },
  'common.logout': { th: 'ออกจากระบบ', en: 'Log out', ms: 'Log keluar', vi: 'Đăng xuất', id: 'Keluar' },
  'common.settings': { th: 'ตั้งค่า', en: 'Settings', ms: 'Tetapan', vi: 'Cài đặt', id: 'Pengaturan' },
  'ws.erp': { th: 'ระบบหลังร้าน (ERP)', en: 'Back office (ERP)', ms: 'Pejabat belakang (ERP)', vi: 'Văn phòng (ERP)', id: 'Kantor belakang (ERP)' },
  'ws.pos': { th: 'หน้าร้าน (POS)', en: 'Storefront (POS)', ms: 'Kedai (POS)', vi: 'Cửa hàng (POS)', id: 'Toko (POS)' },
};
