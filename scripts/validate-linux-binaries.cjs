#!/usr/bin/env node
"use strict";

/**
 * ---------------------------------------------------------------------------
 * scripts/validate-linux-binaries.cjs — اعتبارسنجی عمیق باینری‌های لینوکسی بسته
 * ---------------------------------------------------------------------------
 * ممیزی v1.0.10: «فقط وجود پوشه کافی نیست» — هر باینری باید واقعاً برای
 * معماری و محیط هدف (Linux x64 / glibc ≤ 2.28 — سازگار cPanel EL8/Debian 10)
 * مناسب باشد. این ماژول مستقل از سیستم‌عاملِ Build (ویندوز/لینوکس/مک) کار می‌کند
 * چون بایت‌های فایل را مستقیم پارس می‌کند، نه با ابزار readelf:
 *
 *   ۱) امضای ELF + کلاس ۶۴بیتی + اندین لیتل
 *   ۲) e_machine = 62 (EM_X86_64) — معماری x86-64
 *   ۳) پارس PT_DYNAMIC → DT_VERNEED → حداکثر نسخه GLIBC موردنیاز (مثل 2.28)
 *      و مقایسه با سقف مجاز (env: VIZITO_MAX_GLIBC — پیش‌فرض 2.28)
 *   ۴) موتورهای Prisma: نام فایل باید واریانت glibc باشد (rhel/debian-openssl-*)
 *      — واریانت musl روی cPanel هرگز لود نمی‌شود
 *
 * ⚠️ محدودیت صریح: این بررسی «ساختار فایل» را تضمین می‌کند اما «اجرای واقعی
 * سرور روی هاست لینوکسی» را جایگزین نمی‌کند؛ اگر Build روی ویندوز گرفته شود،
 * تست اجرای واقعی فقط در Production/استیجینگ لینوکسی قابل انجام است
 * (تست اندروید هم مستقل است و در این بسته پوشش داده نمی‌شود).
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

// واریانت‌های مجاز موتور Prisma برای هاست glibc (cPanel — RHEL-family/Debian)
const ALLOWED_PRISMA_VARIANTS = [
  "debian-openssl-1.1.x",
  "rhel-openssl-1.1.x",
  "rhel-openssl-3.0.x",
];
const FORBIDDEN_PRISMA_HINT = "linux-musl";

const EM_X86_64 = 62;
const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const DT_NEEDED = 1;
const DT_STRTAB = 5;
const DT_VERNEED = 0x6ffffffe;
const DT_VERNEEDNUM = 0x6fffffff;

function maxGlibcAllowed() {
  const raw = (process.env.VIZITO_MAX_GLIBC || "2.28").trim();
  const m = /^(\d+)\.(\d+)$/.exec(raw);
  if (!m) throw new Error("VIZITO_MAX_GLIBC نامعتبر است: " + raw);
  return Number(m[1]) * 1000 + Number(m[2]); // 2.28 ⇒ 2028
}

function glibcLabel(v) {
  return Math.floor(v / 1000) + "." + (v % 1000);
}

/** پارس ELF64 — خروجی: {arch, maxGlibc (null=محدودیت پیداشد/نیست), neededCount} */
function parseElf(buf) {
  if (buf.length < 64) throw new Error("فایل کوچک‌تر از هدر ELF است");
  if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
    throw new Error("امضای ELF ندارد");
  }
  const eiClass = buf[4]; // 1=32bit 2=64bit
  const eiData = buf[5]; // 1=LE 2=BE
  if (eiClass !== 2) throw new Error("ELF ۳۲بیتی است (به‌جای ۶۴بیتی)");
  if (eiData !== 1) throw new Error("اندین بایگ لیتل نیست");
  const eMachine = buf.readUInt16LE(18);
  if (eMachine !== EM_X86_64) throw new Error("معماری ELF با x86-64 نمی‌خواند (e_machine=" + eMachine + ")");

  const ePhoff = buf.readBigUInt64LE(32);
  const ePhentsize = buf.readUInt16LE(54);
  const ePhnum = buf.readUInt16LE(56);

  const loads = [];
  let dynamic = null;
  for (let i = 0; i < ePhnum; i++) {
    const ph = Number(ePhoff) + i * ePhentsize;
    if (ph + 56 > buf.length) break;
    const pType = buf.readUInt32LE(ph);
    const pOffset = buf.readBigUInt64LE(ph + 8);
    const pVaddr = buf.readBigUInt64LE(ph + 16);
    const pFilesz = buf.readBigUInt64LE(ph + 32);
    if (pType === PT_LOAD) loads.push({ vaddr: pVaddr, offset: pOffset, filesz: pFilesz });
    if (pType === PT_DYNAMIC) dynamic = { offset: Number(pOffset), size: Number(pFilesz) };
  }

  const vaddrToOffset = (vaddrBig) => {
    const vaddr = Number(vaddrBig);
    for (const l of loads) {
      const start = Number(l.vaddr);
      if (vaddr >= start && vaddr < start + Number(l.filesz)) {
        return vaddr - start + Number(l.offset);
      }
    }
    return null;
  };

  let needed = 0;
  let verneedVersions = [];
  if (dynamic) {
    const strTabOff = dynamic; // فعلاً — پایین با DT_STRTAB پر می‌شود
    void strTabOff;
    let strtab = null;
    const dynEnd = dynamic.offset + dynamic.size;
    const entries = [];
    for (let off = dynamic.offset; off + 16 <= dynEnd; off += 16) {
      const tag = buf.readBigInt64LE(off);
      const val = buf.readBigUInt64LE(off + 8);
      if (tag === 0n) break;
      entries.push([tag, val]);
    }
    for (const [tag, val] of entries) {
      if (tag === BigInt(DT_STRTAB)) strtab = vaddrToOffset(val);
      if (tag === BigInt(DT_NEEDED)) needed++;
    }
    const verneed = entries.find(([tag]) => tag === BigInt(DT_VERNEED));
    const verneedNum = entries.find(([tag]) => tag === BigInt(DT_VERNEEDNUM));
    if (verneed && verneedNum && strtab !== null) {
      let verOff = vaddrToOffset(verneed[1]);
      const count = Number(verneedNum[1]);
      for (let i = 0; i < count && verOff !== null && verOff + 16 <= buf.length; i++) {
        const vnCnt = buf.readUInt16LE(verOff + 2);
        let auxOff = verOff + buf.readUInt32LE(verOff + 8);
        for (let j = 0; j < vnCnt && auxOff + 16 <= buf.length; j++) {
          const vnaName = buf.readUInt32LE(auxOff + 8);
          const vnaNext = buf.readUInt32LE(auxOff + 12);
          const strOff = strtab + vnaName;
          if (strOff < buf.length) {
            const end = buf.indexOf(0, strOff);
            const s = buf.toString("latin1", strOff, end === -1 ? strOff + 32 : end);
            verneedVersions.push(s);
          }
          if (vnaNext === 0) break;
          auxOff += vnaNext;
        }
        const vnNext = buf.readUInt32LE(verOff + 12);
        if (vnNext === 0) break;
        verOff += vnNext;
      }
    }
  }

  // حداکثر GLIBC_x.y از verneed (ورودی‌های GLIBC_ فقط)
  let maxGlibc = null;
  for (const v of verneedVersions) {
    const m = /^GLIBC_(\d+)\.(\d+)$/.exec(v);
    if (m) {
      const n = Number(m[1]) * 1000 + Number(m[2]);
      if (maxGlibc === null || n > maxGlibc) maxGlibc = n;
    }
  }
  return { arch: "x86-64", maxGlibc, neededCount: needed, versions: verneedVersions.filter((v) => /^GLIBC_/.test(v)) };
}

/** اعتبارسنجی یک فایل باینری نسبت به محیط هدف — خطا ⇒ throw با پیام واضح */
function validateElfFile(file, { label = "" } = {}) {
  // کل فایل خوانده می‌شود — سگمنت PT_DYNAMIC ممکن است در باینری‌های بزرگ
  // (مثل libvips ≈ ۲۲MB) در انتهای فایل باشد و خواندن جزئی کافی نیست
  const buf = fs.readFileSync(file);
  const info = parseElf(buf);
  const cap = maxGlibcAllowed();
  if (info.maxGlibc !== null && info.maxGlibc > cap) {
    throw new Error(
      (label ? label + ": " : "") + path.basename(file) +
        " به GLIBC " + glibcLabel(info.maxGlibc) + " نیاز دارد — سقف هدف " + glibcLabel(cap) +
        " (هاست cPanel با GLIBC 2.28 بالا نمی‌آید)"
    );
  }
  return info;
}

function walkFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * اعتبارسنجی کامل باینری‌های لینوکسی در node_modules داده‌شده.
 * @param {string} nm  مسیر node_modules (در Standalone یا در بسته)
 * @param {string} logPrefix  پیشوند لاگ (مثل [vizito] یا [vizito-deploy])
 * @returns {string[]} گزارش خطوط موفقیت
 */
function validateLinuxBinaries(nm, logPrefix = "[vizito]") {
  const report = [];

  // ── ۱) موتورهای Prisma — هم نام‌گذاری پلتفرم، هم خود باینری ELF ──
  const prismaClientDir = path.join(nm, ".prisma", "client");
  if (!fs.existsSync(prismaClientDir)) {
    throw new Error("node_modules/.prisma/client پیدا نشد — کلاینت Prisma ردیابی نشده است");
  }
  const engines = fs.readdirSync(prismaClientDir).filter((f) => /^libquery_engine-.*\.so(\.node)?$/.test(f));
  if (engines.length === 0) {
    throw new Error(
      "هیچ موتور کوئری لینوکسی Prisma (libquery_engine-*.so) موجود نیست — Build روی ویندوز/مک بدون binaryTargets لینوکسی گرفته شده است"
    );
  }
  const glibcEngines = engines.filter((f) => ALLOWED_PRISMA_VARIANTS.some((v) => f.includes(v)));
  if (glibcEngines.length === 0) {
    throw new Error(
      "موتور Prisma برای هاست glibc نیست — واریانت‌های موجود: " + engines.join(", ") +
        " (لازم: یکی از " + ALLOWED_PRISMA_VARIANTS.join(" / ") + ")"
    );
  }
  if (engines.some((f) => f.includes(FORBIDDEN_PRISMA_HINT))) {
    report.push(logPrefix + " ℹ واریانت musl Prisma حاضر است — روی هاست cPanel (glibc) هرگز لود نمی‌شود");
  }
  for (const f of glibcEngines) {
    const info = validateElfFile(path.join(prismaClientDir, f), { label: "Prisma engine" });
    report.push(
      logPrefix + " ✔ Prisma " + f +
        " — ELF x86-64" + (info.maxGlibc !== null ? " — حداکثر GLIBC موردنیاز: " + glibcLabel(info.maxGlibc) : "")
    );
  }

  // ── ۲) باینری‌های sharp لینوکسی x64 — همه فایل‌های .node/.so داخل پکیج‌ها ──
  let sharpChecked = 0;
  for (const d of ["@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64"]) {
    const p = path.join(nm, ...d.split("/"));
    if (!fs.existsSync(p)) {
      throw new Error(
        "پکیج باینری لینوکسی sharp («" + d + "») موجود نیست — بهینه‌سازی تصویر روی هاست شکست می‌خورد"
      );
    }
    const bins = walkFiles(p).filter((f) => /\.(node|so(\.\d+)*)$/.test(f));
    if (bins.length === 0) {
      throw new Error("داخل «" + d + "» هیچ باینری .so/.node پیدا نشد — پکیج ناقص است");
    }
    for (const b of bins) {
      const info = validateElfFile(b, { label: "sharp" });
      sharpChecked++;
      report.push(
        logPrefix + " ✔ sharp " + d + "/" + path.relative(p, b) +
          " — ELF x86-64" + (info.maxGlibc !== null ? " — حداکثر GLIBC موردنیاز: " + glibcLabel(info.maxGlibc) : "")
      );
    }
  }
  if (sharpChecked === 0) throw new Error("هیچ باینری sharp اعتبارسنجی نشد");
  return report;
}

/** خط محدودیت‌ها — همیشه در خروجی packaging چاپ می‌شود */
function limitationsLine(logPrefix = "[vizito]") {
  return [
    logPrefix + " ⚠ محدودیت‌های تست:",
    logPrefix + "   • Build روی ویندوز: ساختار ELF/GLIBC باینری‌ها اینجا اعتبارسنجی می‌شود اما «اجرای واقعی» سرور روی هاست لینوکسی glibc فقط در Production/استیجینگ قابل تست است.",
    logPrefix + "   • تست اندروید (APK) مستقل از این بسته است و اینجا پوشش داده نمی‌شود.",
  ].join("\n");
}

module.exports = { validateLinuxBinaries, validateElfFile, limitationsLine, parseElf };
