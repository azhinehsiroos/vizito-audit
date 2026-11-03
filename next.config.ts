import type { NextConfig } from "next";

/**
 * هدرهای امنیتی — برای انتشار در بازار/مایکت و اجرا زیر HTTPS
 * CSP: در production فقط 'self' + 'unsafe-inline' (Next برای هیدریشن RSC به inline نیاز دارد؛
 * eval فقط در حالت توسعه برای React Refresh لازم است). استایل و فونت از CDN وزیرمتن
 * نکته: محدودیت frame حذف شد تا پنل پیش‌نمایش بتواند برنامه را نمایش دهد؛
 * احراز هویت این برنامه مبتنی بر کوکی HttpOnly (نه localStorage) است،
 * بنابراین ریسک clickjacking عملاً وجود ندارد.
 */
const isProd = process.env.NODE_ENV === "production";
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // امنیت: در production هیچ eval مجاز نیست — فقط inline هیدریشن Next
      `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
      "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
      "font-src 'self' data: https://cdn.jsdelivr.net",
      // امنیت: تصاویر فقط از خود برنامه/dataURL — دامنه‌های خارجی بسته شد (ضد ردیابی و نشت)
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
      // ضد clickjacking در محیط تولید؛ در پیش‌نمایش سندباکس iframe آزاد می‌ماند
      ...(isProd ? ["frame-ancestors 'none'"] : []),
    ].join("; "),
  },
  // ضد clickjacking در تولید (پنل پیش‌نمایش سندباکس به iframe نیاز دارد)
  ...(isProd ? [{ key: "X-Frame-Options", value: "DENY" }] : []),
];

const nextConfig: NextConfig = {
  output: "standalone",
  // سازگاری با هاست اشتراکی: خروجی Standalone باید موتورهای Prisma و باینری‌های
  // لینوکسی sharp را هم همراه خودش داشته باشد؛ node-file-trace فراخوانی
  // داینامیکِ این باینری‌ها را دنبال نمی‌کند ⇒ با این تنظیم به‌صورت قطعی کپی می‌شوند
  // (توجه: مسیرها از node_modules ریشه خوانده می‌شوند و در Standalone بازتاب داده می‌شوند)
  outputFileTracingIncludes: {
    "/**": [
      "./node_modules/.prisma/client/**",
      "./node_modules/@img/sharp-linux-x64/**",
      "./node_modules/@img/sharp-libvips-linux-x64/**",
      "./node_modules/sharp/**",
    ],
  },
  // distDir قابل تنظیم برای Build‌های آزمایشی بدون دست‌زدن به .next پیش‌فرض
  // (پیش‌فرض همان .next است — رفتار عادی build تغییری نمی‌کند)
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // امنیت: خطاهای تایپ نباید بی‌صدا رد شوند — build باید با تایپ سالم شکست بخورد یا رد شود
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
