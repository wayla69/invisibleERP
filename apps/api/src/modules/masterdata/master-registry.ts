import { items, locations, bomMaster, vendors, priceList, promotions } from '../../database/schema';
import { tenants } from '../../database/schema';
import { fixedAssets } from '../../database/schema';
import { menuItems } from '../../database/schema';
import { itemCategories, taxCodes } from '../../database/schema';

export type MdType = 'str' | 'num' | 'int' | 'bool' | 'date';
export interface MdCol {
  header: string;
  prop: string;
  type: MdType;
  // Value substituted when the cell is blank/omitted — lets a bulk import target a NOT-NULL column that
  // has a DB default (an explicit null would violate the constraint; DEFAULT only fires when omitted).
  def?: string | number | boolean;
  // Allowed values for an enum column. Matched case-insensitively and stored lower-cased; a value outside
  // the set is a per-row BAD_ENUM error instead of a hard DB failure inside the import transaction.
  enumVals?: string[];
}
export interface MdEntity {
  key: string;
  labelEn: string;
  labelTh: string;
  table: any;
  required: string[]; // header names required on import
  cols: MdCol[];
  tenantScoped: boolean; // stamp tenantId on insert + RLS-scoped delete
  allowReplace: boolean; // permit destructive "replace all" import
}

const C = (header: string, prop: string, type: MdType = 'str', extra?: Partial<MdCol>): MdCol => ({ header, prop, type, ...extra });

// Generic master-data registry (mirrors the legacy ERPPOS MASTER_REGISTRY).
// Import upserts by natural key (onConflictDoNothing) or appends; export/template via exceljs.
export const MASTER_REGISTRY: MdEntity[] = [
  {
    key: 'items', labelEn: 'Items / Products', labelTh: 'สินค้า / Master',
    table: items, tenantScoped: false, allowReplace: false,
    required: ['Item_ID', 'Item_Description'],
    cols: [
      C('Item_ID', 'itemId'), C('Item_Description', 'itemDescription'), C('UOM', 'uom'),
      C('Base_UOM', 'baseUom'), C('Conversion_Factor', 'conversionFactor', 'num'),
      C('Unit_Price', 'unitPrice', 'num'), C('Category', 'category'),
      C('Min_Stock', 'minStock', 'num'), C('Max_Stock', 'maxStock', 'num'),
      C('Lead_Time_Days', 'leadTimeDays', 'int'),
      // Item-posting setup (docs/33) — optional account/tax profile overrides at the item level.
      C('Category_ID', 'categoryId', 'int'), C('Revenue_Account', 'revenueAccount'),
      C('COGS_Account', 'cogsAccount'), C('Inventory_Account', 'inventoryAccount'),
      C('Valuation_Account', 'valuationAccount'), C('VAT_Code', 'vatCode'),
      C('WHT_Income_Type', 'whtIncomeType'), C('Default_Location_ID', 'defaultLocationId'),
    ],
  },
  {
    // Item / product category master (docs/33) — default account-set + tax profile per item family.
    key: 'item_categories', labelEn: 'Item Categories', labelTh: 'หมวดสินค้า',
    table: itemCategories, tenantScoped: true, allowReplace: true,
    required: ['Code'],
    cols: [
      C('Code', 'code'), C('Name', 'name'), C('Name_Th', 'nameTh'),
      C('Revenue_Account', 'revenueAccount'), C('COGS_Account', 'cogsAccount'),
      C('Inventory_Account', 'inventoryAccount'), C('Valuation_Account', 'valuationAccount'),
      C('VAT_Code', 'vatCode'), C('WHT_Income_Type', 'whtIncomeType'),
      C('Default_Location_ID', 'defaultLocationId'), C('Active', 'active', 'bool', { def: true }),
    ],
  },
  {
    // Tax-code master (docs/33) — VAT + WHT codes with rate + GL accounts.
    key: 'tax_codes', labelEn: 'Tax Codes (VAT / WHT)', labelTh: 'รหัสภาษี (VAT / หัก ณ ที่จ่าย)',
    table: taxCodes, tenantScoped: true, allowReplace: true,
    required: ['Code'],
    cols: [
      C('Code', 'code'), C('Name', 'name'), C('Name_Th', 'nameTh'),
      C('Kind', 'kind', 'str', { def: 'vat', enumVals: ['vat', 'wht'] }),
      C('Rate', 'rate', 'num', { def: 0 }),
      C('Output_Account', 'outputAccount'), C('Input_Account', 'inputAccount'),
      C('WHT_Account', 'whtAccount'), C('WHT_Income_Type', 'whtIncomeType'),
      C('Inclusive', 'inclusive', 'bool', { def: false }), C('Active', 'active', 'bool', { def: true }),
    ],
  },
  {
    key: 'customers', labelEn: 'Customers', labelTh: 'ลูกค้า',
    table: tenants, tenantScoped: false, allowReplace: false,
    required: ['Code', 'Name'],
    cols: [
      C('Code', 'code'), C('Name', 'name'), C('Contact_Name', 'contactName'),
      C('Phone', 'phone'), C('Email', 'email'), C('Tax_ID', 'taxId'), C('Address', 'address'),
      C('Credit_Term', 'creditTerm'), C('Credit_Limit', 'creditLimit', 'num'),
    ],
  },
  {
    key: 'vendors', labelEn: 'Vendors (Suppliers/Creditors)', labelTh: 'ผู้ขาย / เจ้าหนี้',
    table: vendors, tenantScoped: true, allowReplace: true,
    required: ['Vendor_Code', 'Name'],
    cols: [
      C('Vendor_Code', 'vendorCode'), C('Name', 'name'), C('Is_Supplier', 'isSupplier', 'bool'),
      C('Is_Creditor', 'isCreditor', 'bool'), C('Contact', 'contact'), C('Phone', 'phone'),
      C('Email', 'email'), C('Address', 'address'), C('Tax_ID', 'taxId'),
      C('Payment_Terms', 'paymentTerms'), C('Lead_Time_Days', 'leadTimeDays', 'int'),
      C('Credit_Limit', 'creditLimit', 'num'), C('Category', 'category'), C('Active', 'active', 'bool'),
    ],
  },
  {
    key: 'locations', labelEn: 'Warehouse Locations', labelTh: 'คลัง / ตำแหน่งเก็บ',
    table: locations, tenantScoped: false, allowReplace: true,
    required: ['Location_ID', 'Location_Name'],
    cols: [
      C('Location_ID', 'locationId'), C('Location_Name', 'locationName'), C('Zone', 'zone'),
      C('Type', 'type'), C('Capacity', 'capacity', 'num'), C('Temperature', 'temperature'),
      C('Active', 'active', 'bool'), C('Notes', 'notes'),
      // Warehouse posting-account defaults (docs/33 PR5).
      C('Inventory_Account', 'inventoryAccount'), C('Adjustment_Account', 'adjustmentAccount'),
    ],
  },
  {
    key: 'price_list', labelEn: 'Price List', labelTh: 'ราคาพิเศษ',
    table: priceList, tenantScoped: true, allowReplace: true,
    required: ['Item_ID', 'Special_Price'],
    cols: [
      C('List_Name', 'listName'), C('Item_ID', 'itemId'), C('Item_Description', 'itemDescription'),
      C('Base_Price', 'basePrice', 'num'), C('Special_Price', 'specialPrice', 'num'),
      C('Discount_Pct', 'discountPct', 'num'), C('Min_Qty', 'minQty', 'num'),
      C('Valid_From', 'validFrom', 'date'), C('Valid_To', 'validTo', 'date'),
    ],
  },
  {
    key: 'promotions', labelEn: 'Promotions', labelTh: 'โปรโมชั่น',
    table: promotions, tenantScoped: true, allowReplace: true,
    required: ['Promo_ID', 'Promo_Name'],
    cols: [
      C('Promo_ID', 'promoId'), C('Promo_Name', 'promoName'), C('Promo_Type', 'promoType'),
      C('Start_Date', 'startDate', 'date'), C('End_Date', 'endDate', 'date'),
      C('Min_Amount', 'minAmount', 'num'), C('Discount_Pct', 'discountPct', 'num'),
      C('Discount_Amt', 'discountAmt', 'num'), C('Active', 'active', 'bool'),
    ],
  },
  {
    key: 'bom_master', labelEn: 'BoM Master (headers)', labelTh: 'สูตรผลิตกลาง (หัว)',
    table: bomMaster, tenantScoped: false, allowReplace: true,
    required: ['BoM_Code', 'Product_Name'],
    cols: [
      C('BoM_Code', 'bomCode'), C('Product_Name', 'productName'), C('Yield_Qty', 'yieldQty', 'num'),
      C('Yield_UOM', 'yieldUom'), C('Labor_Cost', 'laborCost', 'num'),
      C('Overhead_Cost', 'overheadCost', 'num'), C('Selling_Price', 'sellingPrice', 'num'),
    ],
  },
  {
    // POS menu catalog. Natural key (tenant_id, sku) → uq_menu_sku dedups on re-import (onConflictDoNothing).
    // Category_ID / Station_Code are optional — items load without a category and can be grouped later on
    // the Menu screen. Type / Tax_Type carry DB defaults so blank cells fall back rather than fail.
    key: 'menu_items', labelEn: 'Menu Items (POS)', labelTh: 'เมนูอาหาร (POS)',
    table: menuItems, tenantScoped: true, allowReplace: false,
    required: ['SKU', 'Name', 'Price'],
    cols: [
      C('SKU', 'sku'), C('Name', 'name'), C('Name_En', 'nameEn'),
      C('Category_ID', 'categoryId', 'int'),
      C('Type', 'type', 'str', { def: 'food', enumVals: ['food', 'drink', 'retail', 'combo'] }),
      C('Price', 'price', 'num'), C('Cost', 'cost', 'num'),
      C('Station_Code', 'stationCode', 'str', { def: 'main' }),
      C('Prep_Minutes', 'prepMinutes', 'int', { def: 10 }),
      C('Tax_Type', 'taxType', 'str', { def: 'standard', enumVals: ['standard', 'exempt', 'zero'] }),
      C('Track_Stock', 'trackStock', 'bool', { def: false }),
      C('Description', 'description'), C('Sort', 'sort', 'int', { def: 0 }),
    ],
  },
  {
    key: 'assets', labelEn: 'Fixed Assets', labelTh: 'ทะเบียนทรัพย์สิน',
    table: fixedAssets, tenantScoped: true, allowReplace: false,
    required: ['Asset_No', 'Name', 'Acquire_Date', 'Acquire_Cost', 'Useful_Life_Months'],
    cols: [
      C('Asset_No', 'assetNo'), C('Name', 'name'), C('Acquire_Date', 'acquireDate', 'date'),
      C('Acquire_Cost', 'acquireCost', 'num'), C('Salvage_Value', 'salvageValue', 'num'),
      C('Useful_Life_Months', 'usefulLifeMonths', 'int'), C('Location', 'location'),
      C('Department', 'department'), C('Serial_No', 'serialNo'), C('Assigned_To', 'assignedTo'),
      C('Status', 'status'), C('Notes', 'notes'),
    ],
  },
];

export function findEntity(key: string): MdEntity | undefined {
  return MASTER_REGISTRY.find((e) => e.key === key);
}
