# 02 · Customer Portal

**Status: DRAFT v0.1**

This chapter is for **Customer** users — shop owners and their staff who use the
self-service **portal** to order, run their own till, look up stock, manage
loyalty, and run their own small business ("My Business"). Portal users sign in
the same way as everyone else (see [Getting Started](./00-getting-started.md))
and land on `/portal/dashboard`.

> **Note:** All portal screens live under `/portal/…`. Your side menu shows only
> the portal features your account is allowed to use.

---

## 1. Portal dashboard

**Screen:** `/portal/dashboard` · **Required permission:** `cust_dash`

The dashboard summarises your key numbers (sales, stock alerts, loyalty). It is
your home page after login.

[screenshot: portal dashboard KPIs]

---

## 2. Placing an order

**Screen:** `/order` · **Required permission:** `order_cust`

1. Go to **Order** (`/order`).
2. Browse or search products and add them to your order with quantities.
3. Review the total and submit the order.

**Expected result:** Your order is placed and appears in your order history; you
can follow it under **Track** (see below).

> **Note — credit checks:** If your account has a credit limit or is on hold, an
> order may be blocked (`CREDIT_LIMIT` / `CREDIT_HOLD`). See
> [Troubleshooting & FAQ](./99-troubleshooting-faq.md).

---

## 3. Portal POS (your own till)

**Screen:** `/portal/pos` · **Required permission:** `cust_pos`

Run a retail till for your own shop. This works offline-capable and syncs when
back online.

1. Go to **POS** (`/portal/pos`).
2. Add items by code, quantity and price.
3. Take payment (cash, card, QR / PromptPay, store credit).
4. Confirm the sale and print / send the receipt.

**Expected result:** A sale is recorded against your shop and stock is reduced.

[screenshot: portal POS sale screen]

---

## 4. Inventory lookup

**Screen:** `/inventory` (portal) · **Required permission:** `cust_inventory`

1. Go to **Inventory** (`/inventory`).
2. Search for an item or filter by low stock.
3. View on-hand quantity and reorder points; update reorder settings if allowed.

**Expected result:** You can see current stock levels and which items need
reordering.

---

## 5. Loyalty & points

**Screen:** `/loyalty` · **Required permission:** `loyalty`

1. Go to **Loyalty** (`/loyalty`).
2. View your points balance, tier and RFM standing (how recently / often / how
   much customers buy).
3. Redeem points where offered.

**Expected result:** Points are shown and redemptions are applied.

---

## 6. Recipes / Bill of Materials & variance

- **BOM / Recipes** — `/bom` (permission `cust_bom`): define recipes for items
  you make, listing the ingredients and quantities used. Record production runs to
  consume ingredients and produce finished goods.
- **Variance** — `/variance` (permission `cust_variance`): at end of day, compare
  the **theoretical** ingredient usage (from recipes and sales) against **actual**
  stock movement to spot waste or loss.

[screenshot: end-of-day variance report]

---

## 7. Order tracking & surveys

- **Track** — `/track` (permission `track`): follow the status of your orders
  from placed to delivered.
- **Survey** — `/survey` (permission `survey`): respond to feedback / NPS surveys.

---

## 8. My Business

The **My Business** area lets you manage your own customers, suppliers, purchase
orders and team — a mini-ERP within the portal.

| Task | Screen | Permission |
|------|--------|------------|
| Manage **my customers** (CRM) | `/my/customers` | `cust_my_crm` |
| Manage **my suppliers** | `/my/suppliers` | `cust_my_suppliers` |
| Manage **my purchase orders** | `/my/purchase-orders` | `cust_my_pos` |
| Manage **my users** (team) | `/my/users` | `cust_my_users` |

### Example: add one of your own suppliers

1. Go to **My Suppliers** (`/my/suppliers`).
2. Click **Add supplier** and fill in the details.
3. Save.

**Expected result:** The supplier is saved and available when you raise your own
purchase orders.

### Multi-branch (for portal users with multiple outlets)

**Screen:** `/branches` · **Required permission:** `branch`

Manage your outlets, view consolidated sales across branches, and prepare an
offline data bundle for POS. See [Administration](./11-administration.md) for the
HQ view of branches.

---

**Next:** [Reports & Analytics](./09-reports-and-analytics.md) ·
[Troubleshooting & FAQ](./99-troubleshooting-faq.md)
