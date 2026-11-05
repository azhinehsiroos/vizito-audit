"use client";

import { useEffect } from "react";

/**
 * ثبت Service Worker — پوسته آفلاین (بخش ۵.۱ سند طراحی)
 * -----------------------------------------------------------------------------
 * فقط در production ثبت می‌شود:
 *  - در production نام فایل‌های استاتیک Next همیشه content-hash دارد ⇒ راهبرد
 *    «کش اول» در sw.js امن است.
 *  - در dev نام chunkها هش محتوایی پایدار ندارد ⇒ کش اول SW نسخه قدیمی را
 *    برگرداند و به‌روزرسانی کد به مرورگر نمی‌رسد — به همین دلیل در dev ثبت نمی‌شود.
 *  - حالت آفلاینِ «داده» (IndexedDB/اسنپ‌شات/صف سفارش) مستقل از SW است و در dev
 *    هم کامل کار می‌کند؛ SW فقط «بارگذاری خود صفحه بدون شبکه» را اضافه می‌کند.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    if (location.protocol !== "http:" && location.protocol !== "https:") return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {
        // ثبت ناموفق (مثلاً بستر بدون SW) — برنامه آنلاین عادی می‌ماند
      });
    };
    if (document.readyState === "complete") register();
    else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);
  return null;
}
