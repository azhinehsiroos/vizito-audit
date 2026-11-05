/**
 * Service Worker ویزیتو — پوسته آفلاین (بخش ۵.۱ سند طراحی SaaS)
 * -----------------------------------------------------------------------------
 * هدف: بارگذاری برنامه بدون شبکه (پوسته) + فونت/آیکون‌ها؛ «هیچ‌گاه» پاسخ API
 * کش نمی‌شود — داده آفلاین فقط از طریق IndexedDB (src/lib/idb.ts) مدیریت می‌شود.
 *
 * راهبردها:
 *  - ناوبری (صفحه): شبکه اول؛ در قطعی ← نسخه کش‌شده «/»
 *  - استاتیک هش‌دار (/_next/static) و فونت‌ها: کش اول (immutable)
 *  - /api/*: عبور مستقیم به شبکه — بدون هیچ کشی (منبع حقیقت فقط سرور)
 *
 * نکته امنیتی: کوکی HttpOnly توسط مرورگر در همان درخواست ناوبری فرستاده می‌شود؛
 * SW هیچ توکنی نمی‌بیند و نمی‌تواند بخواند (به پاسخ‌ها دسترسی دارد ولی هیچ
 * احراز هویتی از طریق SW انجام نمی‌شود).
 */

const CACHE = "vizito-shell-v1";

/** پیش‌بارگذاری پوسته — منابع ثابت (فونت self-host از فاز پشتیبانی) */
const PRECACHE = [
  "/",
  "/manifest.json",
  "/vizito-logo.svg",
  "/logo.svg",
  "/fonts/Vazirmatn-Regular.woff2",
  "/fonts/Vazirmatn-Bold.woff2",
  "/fonts/Vazirmatn-Medium.woff2",
  "/fonts/Vazirmatn-SemiBold.woff2",
  "/fonts/Vazirmatn-Light.woff2",
  "/fonts/Vazirmatn-Black.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // افزودن تکی — اگر یکی نبود بقیه پوسته از دست نمی‌روند
      await Promise.all(
        PRECACHE.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => {}))
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // پاک‌سازی کش نسخه‌های قبلی
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // فقط GET — تغییردهنده‌ها همیشه به شبکه (و سرور گیت CSRF/نشست دارد)
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // منابع خارجی نداریم — احتیاط
  // API هرگز کش نمی‌شود
  if (url.pathname.startsWith("/api/")) return;

  // ناوبری صفحه — شبکه اول، قطعی ← پوسته کش‌شده
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          // نسخه تازه را برای قطعی بعدی نگه می‌داریم
          const cache = await caches.open(CACHE);
          cache.put("/", fresh.clone()).catch(() => {});
          return fresh;
        } catch {
          const cache = await caches.open(CACHE);
          return (await cache.match("/")) || (await cache.match(req)) || Response.error();
        }
      })()
    );
    return;
  }

  // استاتیک هش‌دار و فونت‌ها — کش اول (URL هش‌دار یعنی تغییر محتوا = تغییر URL)
  const isStatic =
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/fonts/") ||
    url.pathname === "/vizito-logo.svg" ||
    url.pathname === "/logo.svg" ||
    url.pathname === "/vizito-logo.png" ||
    url.pathname === "/manifest.json";
  if (isStatic) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const fresh = await fetch(req);
          if (fresh.ok) cache.put(req, fresh.clone()).catch(() => {});
          return fresh;
        } catch {
          return Response.error();
        }
      })()
    );
  }
  // بقیه (/_next/data، فایل‌های dev و ...) — شبکه مستقیم
});
