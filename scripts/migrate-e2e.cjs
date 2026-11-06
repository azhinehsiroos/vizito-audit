#!/usr/bin/env node
"use strict";

/**
 * ---------------------------------------------------------------------------
 * scripts/migrate-e2e.cjs — تست واقعی Baseline ساختاری مهاجرت SQLite (v1.0.10)
 * ---------------------------------------------------------------------------
 * سناریوها (همه روی دیتابیس‌های موقت در پوشه temp سیستم — دیتابیس واقعی دست‌نخورده):
 *   ۱) دیتابیس خالی            ⇒ همه مهاجرت‌ها اجرا می‌شود
 *   ۲) دیتابیس کامل «db-push»  (ساختار آخر بدون رکورد) ⇒ baseline ساختاری، بدون اجرای SQL، داده‌ها دست‌نخورده
 *   ۳) اجرای مجدد روی دیتابیس مهاجرت‌شده ⇒ بدون تغییر (idempotent)
 *   ۴) دیتابیس نیمه‌کاره (وضعیت میانی k) ⇒ ادامه از همان نقطه (شبیه‌سازی بازیابی پس از قطع)
 *   ۵) دیتابیس ناقص (جدول ناقص) ⇒ توقف کامل بدون تغییر
 *   ۶) دیتابیس ناسازگار (جدول اضافه غریبه) ⇒ توقف کامل بدون تغییر
 *   ۷) رکورد مهاجرت بدون ساختار متناظر ⇒ توقف (ناسازگاری جدول مهاجرت و ساختار)
 *   ۸) دیتابیس دارای داده + رکورد کامل ⇒ بدون تغییر (حفظ داده)
 *   ۹) بک‌فیل چندمجموعه‌ای (SaaS) روی داده قدیمی ⇒ مجموعه + نقش‌ها + لایسنس + پوشش orgId — بدون حذف
 *
 * اجرا:  node scripts/migrate-e2e.cjs
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { runMigrations } = require("./migrate-sqlite.cjs");

const MIGRATIONS_DIR = path.join(__dirname, "..", "prisma", "migrations");
// تعداد مهاجرت‌ها پویا خوانده می‌شود — با افزودن مهاجرت جدید تست‌ها خودکار سازگار می‌شوند
const MIG_COUNT = require("fs").readdirSync(MIGRATIONS_DIR).filter((d) => /^\d{14}_/.test(d)).sort().length;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "vizito-migrate-e2e-"));

const PRISMA_MIG_TABLE = `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" VARCHAR(36) NOT NULL PRIMARY KEY,
  "checksum" VARCHAR(64) NOT NULL,
  "finished_at" DATETIME,
  "migration_name" VARCHAR(255) NOT NULL,
  "logs" TEXT,
  "rolled_back_at" DATETIME,
  "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
)`;

let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log("  ✅ " + m); };
const bad = (m) => { fail++; console.log("  ❌ " + m); };

function freshDb(file) {
  return new DatabaseSync(file, { enableForeignKeyConstraints: false });
}

function counts(dbo) {
  const t = (q) => dbo.prepare(q).get().n;
  return JSON.stringify({
    User: t('SELECT COUNT(*) n FROM "User"'),
    Customer: t('SELECT COUNT(*) n FROM "Customer"'),
    Order: t('SELECT COUNT(*) n FROM "Order"'),
    OrderItem: t('SELECT COUNT(*) n FROM "OrderItem"'),
    Payment: t('SELECT COUNT(*) n FROM "Payment"'),
    Product: t('SELECT COUNT(*) n FROM "Product"'),
    AuthSession: t('SELECT COUNT(*) n FROM "AuthSession"'),
  });
}

function migrationRecords(dbo) {
  return dbo
    .prepare("SELECT migration_name FROM _prisma_migrations WHERE rolled_back_at IS NULL ORDER BY migration_name")
    .all()
    .map((r) => r.migration_name);
}

/** ساختار (همان منطق اسکریپت اصلی — برای تأیید مستقل) */
function structure(dbo) {
  const tables = dbo
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations' ORDER BY name")
    .all()
    .map((r) => r.name);
  const snap = {};
  for (const t of tables) {
    snap[t] = {
      columns: dbo.prepare(`PRAGMA table_info("${t}")`).all().map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]).sort(),
      fks: dbo.prepare(`PRAGMA foreign_key_list("${t}")`).all().map((r) => [r.table, r.from, r.to, r.on_delete, r.on_update]).sort(),
      idx: dbo.prepare(`PRAGMA index_list("${t}")`).all().filter((r) => r.origin === "c" || r.origin === "u").map((r) => [r.name, r.unique]).sort(),
    };
  }
  return JSON.stringify(snap);
}

/** پرکردن داده نمونه (مشتری/سفارش/پرداخت) برای سناریوهای «کامل» */
function seedData(dbo) {
  dbo.exec(`
    INSERT INTO "User" ("id","mobile","name","password","role","createdAt","updatedAt")
      VALUES ('u1','09120000001','تست','x:s','ADMIN',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    INSERT INTO "Customer" ("id","name","phone","type","createdAt","updatedAt")
      VALUES ('c1','مشتری تست','09120000002','STORE',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    INSERT INTO "Order" ("id","customerId","priceType","status","totalAmount","createdAt","updatedAt")
      VALUES ('o1','c1','STORE','FINAL',1000,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    INSERT INTO "OrderItem" ("id","orderId","productName","quantity","price","discount","lineTotal","rowNumber","createdAt")
      VALUES ('oi1','o1','کالا',1,1000,0,1000,1,CURRENT_TIMESTAMP);
    INSERT INTO "Payment" ("id","customerId","orderId","type","amount","discountPercent","discountAmount","createdAt")
      VALUES ('p1','c1','o1','CASH',500,0,0,CURRENT_TIMESTAMP);
  `);
}

console.log("════════ تست‌های Baseline ساختاری مهاجرت SQLite — " + TMP + " ════════");

/* ── سناریو ۱: دیتابیس خالی → همه مهاجرت‌ها اجرا شود ── */
console.log("\n── ۱) دیتابیس خالی ──");
{
  const f = path.join(TMP, "s1.db");
  runMigrations({ dbFile: f, migrationsDir: MIGRATIONS_DIR });
  const dbo = freshDb(f);
  const recs = migrationRecords(dbo);
  const all = fs.readdirSync(MIGRATIONS_DIR).filter((d) => /^\d{14}_$/.test(d) || (/^\d{14}_/.test(d)));
  if (recs.length === all.length && recs.length >= 4) ok("همه " + recs.length + " مهاجرت اعمال/ثبت شد");
  else bad("رکوردها ناقص: " + JSON.stringify(recs));
  // ساختار Customer باید ستون آرشیو داشته باشد و Order باید RESTRICT داشته باشد
  const hasArchived = dbo.prepare('PRAGMA table_info("Customer")').all().some((c) => c.name === "archived");
  const orderFk = dbo.prepare('PRAGMA foreign_key_list("Order")').all().find((r) => r.table === "Customer");
  if (hasArchived && orderFk && orderFk.on_delete === "RESTRICT")
    ok("ساختار نهایی درست است (Customer.archived + Order FK=RESTRICT)");
  else bad("ساختار نهایی نادرست: archived=" + hasArchived + " fk=" + JSON.stringify(orderFk));
  dbo.close();
}

/* ── سناریو ۲: دیتابیس کامل db-push (ساختار آخر، بدون رکورد) → baseline ساختاری ── */
console.log("\n── ۲) دیتابیس کامل db-push بدون رکورد مهاجرت (baseline ساختاری) ──");
{
  const f = path.join(TMP, "s2.db");
  runMigrations({ dbFile: f, migrationsDir: MIGRATIONS_DIR }); // ساخت + رکورد
  let dbo = freshDb(f);
  seedData(dbo);
  dbo.exec('DELETE FROM "_prisma_migrations";'); // تبدیل به دیتابیس «db-push بدون رکورد»
  const before = counts(dbo);
  const beforeStructure = structure(dbo);
  dbo.close();

  let logs = [];
  const origLog = console.log;
  console.log = (...a) => { logs.push(a.join(" ")); };
  runMigrations({ dbFile: f, migrationsDir: MIGRATIONS_DIR });
  console.log = origLog;
  logs.forEach((l) => console.log("      " + l.trim()));

  dbo = freshDb(f);
  const recs = migrationRecords(dbo);
  const after = counts(dbo);
  const afterStructure = structure(dbo);
  const baselineMentioned = logs.join("\n").includes("baseline");
  if (recs.length === MIG_COUNT && baselineMentioned) ok("همه مهاجرت‌ها baseline ساختاری شدند (بدون اجرای SQL)");
  else bad("baseline ناموفق: رکورد=" + recs.length + " baselineMentioned=" + baselineMentioned);
  if (before === after && beforeStructure === afterStructure) ok("داده‌ها و ساختار دقیقاً دست‌نخورده ماند (" + after + ")");
  else bad("تغییر ناخواسته در داده/ساختار! قبل=" + before + " بعد=" + after);
  dbo.close();
}

/* ── سناریو ۳: اجرای مجدد (idempotent) ── */
console.log("\n── ۳) اجرای مجدد روی دیتابیس مهاجرت‌شده (بدون تغییر) ──");
{
  const f = path.join(TMP, "s3.db");
  runMigrations({ dbFile: f, migrationsDir: MIGRATIONS_DIR });
  let dbo = freshDb(f);
  seedData(dbo);
  const before = counts(dbo);
  dbo.close();
  runMigrations({ dbFile: f, migrationsDir: MIGRATIONS_DIR });
  dbo = freshDb(f);
  if (counts(dbo) === before && migrationRecords(dbo).length === MIG_COUNT) ok("اجرای مجدد: هیچ تغییری نکرد (idempotent)");
  else bad("اجرای مجدد داده را تغییر داد!");
  dbo.close();
}

/* ── سناریو ۴: دیتابیس نیمه‌کاره (وضعیت میانی، بدون رکورد برای ادامه) → ادامه از همان نقطه ── */
console.log("\n── ۴) بازیابی پس از قطع ناگهانی (وضعیت میانی k=2) ──");
{
  const f = path.join(TMP, "s4.db");
  runMigrations({ dbFile: f, migrationsDir: MIGRATIONS_DIR });
  let dbo = freshDb(f);
  // عقب‌گرد به وضعیت میانی: جدول‌های آرشیو و FK جدید حذف... حذف ستون در SQLite راحت نیست؛
  // به‌جایش وضعیت میانی واقعی می‌سازیم: دیتابیس تازه + فقط ۲ مهاجرت اول
  dbo.close();
  const f2 = path.join(TMP, "s4-mid.db");
  const mid = freshDb(f2);
  mid.exec(PRISMA_MIG_TABLE);
  const dirs = fs.readdirSync(MIGRATIONS_DIR).filter((d) => /^\d{14}_/.test(d)).sort();
  for (const d of dirs.slice(0, 2)) {
    mid.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, d, "migration.sql"), "utf8"));
  }
  mid.exec('INSERT INTO "_prisma_migrations" ("id","checksum","migration_name","started_at") VALUES (\'r1\',\'x\',\'' + dirs[0] + '\',CURRENT_TIMESTAMP)');
  mid.close();
  runMigrations({ dbFile: f2, migrationsDir: MIGRATIONS_DIR });
  dbo = freshDb(f2);
  const recs = migrationRecords(dbo);
  const hasArchived = dbo.prepare('PRAGMA table_info("Customer")').all().some((c) => c.name === "archived");
  const orderFk = dbo.prepare('PRAGMA foreign_key_list("Order")').all().find((r) => r.table === "Customer");
  if (recs.length === MIG_COUNT && hasArchived && orderFk && orderFk.on_delete === "RESTRICT")
    ok("از وضعیت میانی ادامه داد و به ساختار آخر رسید (" + recs.length + " مهاجرت)");
  else bad("ادامه از وضعیت میانی ناموفق: recs=" + recs.length);
  dbo.close();
}

/* ── سناریو ۵: دیتابیس ناقص → توقف بدون تغییر ── */
console.log("\n── ۵) دیتابیس ناقص (جدول Customer ستون تلفن ندارد) ──");
{
  const f = path.join(TMP, "s5.db");
  const dbo = freshDb(f);
  // ساخت دیتابیس «شبیه ولی ناقص»: جدول User هست، Customer ناقص است
  dbo.exec(`CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY, "mobile" TEXT NOT NULL, "name" TEXT NOT NULL,
    "company" TEXT, "password" TEXT NOT NULL, "role" TEXT NOT NULL DEFAULT 'USER',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL);
    CREATE TABLE "Customer" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL);`);
  dbo.close();
  const sizeBefore = fs.statSync(f).size;
  let aborted = false;
  let msg = "";
  try {
    runMigrations({ dbFile: f, migrationsDir: MIGRATIONS_DIR });
  } catch (e) {
    aborted = true;
    msg = String(e && e.message);
  }
  const dbo2 = freshDb(f);
  const recs = migrationRecords(dbo2);
  const custCols = dbo2.prepare('PRAGMA table_info("Customer")').all().map((c) => c.name);
  dbo2.close();
  if (aborted && msg.includes("همخوان نیست")) ok("توقف با پیام ساختاری: " + msg.split("\n")[0].slice(0, 80) + "…");
  else bad("دیتابیس ناقص متوقف نشد! aborted=" + aborted + " msg=" + msg.slice(0, 100));
  if (recs.length === 0 && custCols.join(",") === "id,name") ok("هیچ رکورد/تغییری ثبت نشد (ساختار ناقص دست‌نخورده)");
  else bad("دیتابیس ناقص تغییر کرد! recs=" + recs.length);
}

/* ── سناریو ۶: دیتابیس ناسازگار (جدول اضافه غریبه) → توقف بدون تغییر ── */
console.log("\n── ۶) دیتابیس با جدول اضافه غریبه ──");
{
  const f = path.join(TMP, "s6.db");
  runMigrations({ dbFile: f, migrationsDir: MIGRATIONS_DIR });
  let dbo = freshDb(f);
  dbo.exec('CREATE TABLE "Hacker_Extra" ("x" TEXT);');
  const before = structure(dbo);
  dbo.close();
  let aborted = false;
  let msg = "";
  try {
    runMigrations({ dbFile: f, migrationsDir: MIGRATIONS_DIR });
  } catch (e) {
    aborted = true;
    msg = String(e && e.message);
  }
  const dbo2 = freshDb(f);
  const after = structure(dbo2);
  dbo2.close();
  if (aborted && msg.includes("جدول اضافه در دیتابیس")) ok("توقف با تشخیص جدول غریبه: " + msg.split("\n")[0].slice(0, 60) + "…");
  else bad("جدول غریبه تشخیص داده نشد! aborted=" + aborted + " msg=" + msg.slice(0, 120));
  if (before === after) ok("ساختار دست‌نخورده ماند");
  else bad("ساختار تغییر کرد!");
}

/* ── سناریو ۷: رکورد مهاجرت بدون ساختار متناظر → توقف ── */
console.log("\n── ۷) ناسازگاری جدول مهاجرت با ساختار (رکورد هست، ساختار عقب است) ──");
{
  const f = path.join(TMP, "s7.db");
  runMigrations({ dbFile: f, migrationsDir: MIGRATIONS_DIR });
  let dbo = freshDb(f);
  // رکورد مهاجرت سوم و چهارم را نگه می‌داریم ولی ساختار را به قبل از آرشیو برمی‌گردانیم:
  // شبیه‌سازی: دیتابیس تازه با ۲ مهاجرت اول (ساختار) + همه ۴ رکورد
  dbo.close();
  const f2 = path.join(TMP, "s7-mid.db");
  const mid = freshDb(f2);
  mid.exec(PRISMA_MIG_TABLE);
  const dirs = fs.readdirSync(MIGRATIONS_DIR).filter((d) => /^\d{14}_/.test(d)).sort();
  for (const d of dirs.slice(0, 2)) {
    mid.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, d, "migration.sql"), "utf8"));
  }
  for (let i = 0; i < MIG_COUNT; i++) {
    mid.exec('INSERT INTO "_prisma_migrations" ("id","checksum","migration_name","started_at") VALUES (\'r' + i + '\',\'x\',\'' + dirs[i] + '\',CURRENT_TIMESTAMP)');
  }
  mid.close();
  let aborted = false;
  let msg = "";
  try {
    runMigrations({ dbFile: f2, migrationsDir: MIGRATIONS_DIR });
  } catch (e) {
    aborted = true;
    msg = String(e && e.message);
  }
  const dbo2 = freshDb(f2);
  const recs = migrationRecords(dbo2);
  const hasArchived = dbo2.prepare('PRAGMA table_info("Customer")').all().some((c) => c.name === "archived");
  dbo2.close();
  if (aborted && msg.includes("ناسازگاری جدول مهاجرت")) ok("توقف با پیام ناسازگاری رکورد/ساختار");
  else bad("ناسازگاری رکورد تشخیص داده نشد! aborted=" + aborted + " msg=" + msg.slice(0, 120));
  if (recs.length === MIG_COUNT && !hasArchived) ok("هیچ تغییری در ساختار/رکورد داده نشد");
  else bad("وضعیت تغییر کرد! recs=" + recs.length + " archived=" + hasArchived);
}

/* ── سناریو ۸: دیتابیس واقعی‌مانند با داده و رکورد کامل → بدون تغییر (پوشش حفظ داده) ── */
console.log("\n── ۸) دیتابیس دارای داده + رکورد کامل (شبیه production) ──");
{
  const f = path.join(TMP, "s8.db");
  runMigrations({ dbFile: f, migrationsDir: MIGRATIONS_DIR });
  let dbo = freshDb(f);
  seedData(dbo);
  const before = counts(dbo);
  const beforeStruct = structure(dbo);
  dbo.close();
  runMigrations({ dbFile: f, migrationsDir: MIGRATIONS_DIR });
  dbo = freshDb(f);
  const okData = counts(dbo) === before && structure(dbo) === beforeStruct;
  if (okData) ok("داده‌ها (" + before + ") و ساختار پس از اجرای مجدد کامل حفظ شد");
  else bad("از دست رفتن داده در اجرای مجدد!");
  dbo.close();
}

/* ── سناریو ۹: بک‌فیل چندمجموعه‌ای (SaaS) روی نصب قدیمی ── */
console.log("\n── ۹) بک‌فیل چندمجموعه‌ای: مجموعه + نقش‌ها + لایسنس + پوشش orgId ──");
{
  const { execFileSync } = require("child_process");
  const f = path.join(TMP, "s9.db");
  runMigrations({ dbFile: f, migrationsDir: MIGRATIONS_DIR });
  let dbo = freshDb(f);
  // داده «قدیمی» تک‌شرکتی: یک ADMIN مالک + یک ADMIN معمولی + یک USER + داده تجاری بدون orgId
  const OWNER_M = "09129999001";
  dbo.exec(`
    INSERT INTO "User" ("id","mobile","name","password","role","kind","createdAt","updatedAt")
      VALUES ('u-owner','${OWNER_M}','مالک','x:s','ADMIN','STAFF',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    INSERT INTO "User" ("id","mobile","name","password","role","kind","createdAt","updatedAt")
      VALUES ('u-admin','09129999002','مدیر خریدار','x:s','ADMIN','STAFF',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    INSERT INTO "User" ("id","mobile","name","password","role","kind","createdAt","updatedAt")
      VALUES ('u-staff','09129999003','پرسنل','x:s','USER','STAFF',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    INSERT INTO "Customer" ("id","name","phone","type","createdAt","updatedAt")
      VALUES ('c1','مشتری قدیمی','09120000002','STORE',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    INSERT INTO "ProductGroup" ("id","name","createdAt","updatedAt")
      VALUES ('g1','گروه قدیمی',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    INSERT INTO "Product" ("id","groupId","name","pricePurchase","priceStore","pricePharmacy","priceSalon","discount","minOrder","createdAt","updatedAt")
      VALUES ('p1','g1','کالای قدیمی',0,1000,0,0,0,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    INSERT INTO "Order" ("id","customerId","priceType","status","totalAmount","createdAt","updatedAt")
      VALUES ('o1','c1','STORE','FINAL',1000,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    INSERT INTO "OrderItem" ("id","orderId","productName","quantity","price","discount","lineTotal","rowNumber","createdAt")
      VALUES ('oi1','o1','کالا',1,1000,0,1000,1,CURRENT_TIMESTAMP);
    INSERT INTO "Payment" ("id","customerId","orderId","type","amount","discountPercent","discountAmount","createdAt")
      VALUES ('p1','c1','o1','CASH',500,0,0,CURRENT_TIMESTAMP);
  `);
  const beforeCounts = counts(dbo);
  dbo.close();

  // اجرای بک‌فیل با env مالک — پروسه جدا مثل production
  let bfOut = "";
  try {
    bfOut = execFileSync("node", [path.join(__dirname, "backfill-multi-tenant.cjs")], {
      env: { ...process.env, DATABASE_URL: "file:" + f, OWNER_MOBILES: OWNER_M },
      encoding: "utf8",
    });
  } catch (e) {
    bad("اجرای بک‌فیل شکست خورد: " + String(e && e.message).slice(0, 120));
  }
  if (bfOut.includes("بک‌فیل کامل شد")) ok("بک‌فیل اجرا شد و صحت‌سنجی داخلی خودش را پاس کرد");
  else if (!bfOut) bad("خروجی بک‌فیل خالی است");

  dbo = freshDb(f);
  const orgCount = dbo.prepare('SELECT COUNT(*) n FROM "Org"').get().n;
  if (orgCount === 1) ok("دقیقاً یک مجموعه پیش‌فرض ساخته شد");
  else bad("تعداد مجموعه‌ها نادرست: " + orgCount);

  const roles = dbo.prepare('SELECT mobile, role, orgId FROM "User" ORDER BY mobile').all();
  const ownerRow = roles.find((r) => r.mobile === OWNER_M);
  const adminRow = roles.find((r) => r.mobile === "09129999002");
  const staffRow = roles.find((r) => r.mobile === "09129999003");
  if (ownerRow && ownerRow.role === "SUPER_ADMIN" && ownerRow.orgId === null)
    ok("مالک → SUPER_ADMIN خارج از مجموعه");
  else bad("نگاشت مالک نادرست: " + JSON.stringify(ownerRow));
  if (adminRow && adminRow.role === "ORG_ADMIN" && adminRow.orgId)
    ok("ADMIN → ORG_ADMIN عضو مجموعه");
  else bad("نگاشت مدیر نادرست: " + JSON.stringify(adminRow));
  if (staffRow && staffRow.role === "VISITOR" && staffRow.orgId)
    ok("USER → VISITOR عضو مجموعه");
  else bad("نگاشت پرسنل نادرست: " + JSON.stringify(staffRow));

  const lic = dbo.prepare('SELECT plan, status, expiresAt FROM "License"').get();
  if (lic && lic.plan === "PERM" && lic.expiresAt === null && lic.status === "ACTIVE")
    ok("لایسنس مجموعه پیش‌فرض = دائمی (حساب سازنده موجود بود)");
  else bad("لایسنس مهاجرت نادرست: " + JSON.stringify(lic));

  const nullOrg = (t) => dbo.prepare(`SELECT COUNT(*) n FROM "${t}" WHERE "orgId" IS NULL`).get().n;
  const nc = nullOrg("Customer"), np = nullOrg("Product"), no = nullOrg("Order"), npay = nullOrg("Payment"), ng = nullOrg("ProductGroup");
  if (nc + np + no + npay + ng === 0) ok("پوشش orgId کامل در جداول تجاری (صفر ردیف تهی)");
  else bad("ردیف‌های بدون مجموعه: Customer=" + nc + " Product=" + np + " Order=" + no + " Payment=" + npay + " Group=" + ng);

  const afterCounts = counts(dbo);
  if (beforeCounts === afterCounts) ok("شمارش رکوردها دقیقاً حفظ شد (" + afterCounts + ")");
  else bad("شمارش رکوردها تغییر کرد! قبل=" + beforeCounts + " بعد=" + afterCounts);
  dbo.close();

  // اجرای مجدد بک‌فیل — idempotent
  let bf2 = "";
  try {
    bf2 = execFileSync("node", [path.join(__dirname, "backfill-multi-tenant.cjs")], {
      env: { ...process.env, DATABASE_URL: "file:" + f, OWNER_MOBILES: OWNER_M },
      encoding: "utf8",
    });
  } catch (e) {
    bad("اجرای مجدد بک‌فیل خطا داد: " + String(e && e.message).slice(0, 120));
  }
  dbo = freshDb(f);
  const orgCount2 = dbo.prepare('SELECT COUNT(*) n FROM "Org"').get().n;
  const licCount2 = dbo.prepare('SELECT COUNT(*) n FROM "License"').get().n;
  if (bf2.includes("از قبل مهاجرت انجام شده") && orgCount2 === 1 && licCount2 === 1)
    ok("اجرای مجدد بک‌فیل idempotent است (مجموعه/لایسنس تکراری نساخت)");
  else bad("اجرای مجدد بک‌فیل idempotent نیست: orgs=" + orgCount2 + " lic=" + licCount2);
  dbo.close();
}

console.log("\n═══ نتیجه migrate-e2e: ✅ " + pass + " موفق — ❌ " + fail + " ناموفق ═══");
console.log("(پوشه موقت: " + TMP + " — پاک نشد برای بازبینی دستی)");
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
