import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Providers } from "@/components/vizito/Providers";
import { ServiceWorkerRegister } from "@/components/vizito/ServiceWorkerRegister";

export const metadata: Metadata = {
  title: "ویزیتو | VIZITO",
  description: "اپلیکیشن ویزیت محصولات آرایشی و بهداشتی",
  icons: { icon: "/vizito-logo.svg" },
  manifest: "/manifest.json",
  applicationName: "ویزیتو",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f4f0" },
    { media: "(prefers-color-scheme: dark)", color: "#0f0d0b" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fa" dir="rtl" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground min-h-screen">
        <Providers>{children}</Providers>
        <Toaster />
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
