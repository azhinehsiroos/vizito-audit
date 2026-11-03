"use client";

import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/lib/store";
import { api, saveFallbackToken } from "@/lib/api";
import { Shell } from "@/components/vizito/Shell";
import { AuthScreen } from "@/components/vizito/AuthScreen";
import { Dashboard } from "@/components/vizito/Dashboard";
import { CustomersView } from "@/components/vizito/CustomersView";
import { CustomerProfile } from "@/components/vizito/CustomerProfile";
import { ProductsView } from "@/components/vizito/ProductsView";
import { OrdersView, OrderForm } from "@/components/vizito/OrdersView";
import { OrderDetail } from "@/components/vizito/OrderDetail";
import { ReportsView } from "@/components/vizito/ReportsView";
import { CatalogView } from "@/components/vizito/CatalogView";
import { UsersView } from "@/components/vizito/UsersView";
import { SettingsView } from "@/components/vizito/SettingsView";
import { BackupView } from "@/components/vizito/BackupView";
import { LicenseSalesView } from "@/components/vizito/LicenseSalesView";
import { LicenseScreen, type LicenseState } from "@/components/vizito/LicenseScreen";
import { Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { ShieldOff } from "lucide-react";

export function VizitoApp() {
  const { view, me, authLoading, setMe, setAuthLoading, setLogo } = useApp();
  const [license, setLicense] = useState<LicenseState | null>(null);
  const [licenseLoading, setLicenseLoading] = useState(true);

  const loadLicense = useCallback(async () => {
    try {
      const res = await fetch("/api/license/status", { cache: "no-store" });
      setLicense((await res.json()) as LicenseState);
    } catch {
      setLicense({ activated: false, valid: false, name: null, mobile: null, expiresAt: null, daysLeft: null });
    } finally {
      setLicenseLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLicense();
  }, [loadLicense]);

  // پس از ورود/ثبت‌نام (تغییر کاربر) وضعیت لایسنس دوباره بررسی شود —
  // مهم: پس از ثبت‌نام اولین مدیر روی نصب تازه، تریال/دسترسی فعال می‌شود و باید قفل برداشته شود
  const meId = me?.id;
  useEffect(() => {
    if (meId) void loadLicense();
  }, [meId, loadLicense]);

  useEffect(() => {
    // بوت اصلی وقتی انجام می‌شود که لایسنس معتبر باشد «یا نصب تازه باشد» —
    // روی نصب تازه (بدون هیچ حسابی) بک‌اند ثبت‌نام اولین مدیر را بدون لایسنس مجاز می‌داند
    // (با SETUP_TOKEN + تریال ۲۴ ساعته) پس باید صفحه ورود/ثبت‌نام دیده شود نه قفل لایسنس
    if (!license || (!license.valid && !license.freshInstall)) return;
    const boot = async () => {
      // تنظیمات برند (لوگو) — عمومی و بدون نیاز به ورود
      try {
        const s = await api<{ logo: string | null }>("/api/settings");
        setLogo(s.logo);
      } catch {
        // لوگوی پیش‌فرض می‌ماند
      }
      // احراز هویت با کوکی HttpOnly — همیشه سمت سرور چک می‌شود (۴۰۱ ⇒ صفحه ورود)
      try {
        const res = await api<{
          user: { id: string; mobile: string; name: string; company: string | null; role: string };
          sections: string[];
          grantExpiresAt: string | null;
          isAdmin: boolean;
          isOwner?: boolean;
        }>("/api/auth/me");
        setMe({
          id: res.user.id,
          mobile: res.user.mobile,
          name: res.user.name,
          company: res.user.company,
          role: res.user.role,
          sections: res.sections,
          grantExpiresAt: res.grantExpiresAt,
          isAdmin: res.isAdmin,
          isOwner: !!res.isOwner,
        });
      } catch {
        // توکن نامعتبر است
      } finally {
        setAuthLoading(false);
      }
    };
    boot();
  }, [setMe, setAuthLoading, setLogo, license]);

  if (licenseLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-xs text-muted-foreground">در حال بررسی لایسنس...</p>
        </div>
      </div>
    );
  }

  // قفل لایسنس — کل اپ پشت این صفحه است (داده‌ها محفوظ می‌مانند)
  // استثنا: نصب تازه — چون ثبت‌نام اولین مدیر هنوز انجام نشده و بک‌اند آن را بدون لایسنس مجاز می‌داند
  if (license && !license.valid && !license.freshInstall) {
    return <LicenseScreen state={license} onActivated={() => void loadLicense()} />;
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-xs text-muted-foreground">در حال بارگذاری ویزیتو...</p>
        </div>
      </div>
    );
  }

  if (!me) {
    return <AuthScreen />;
  }

  // کاربر بدون دسترسی (غیر مدیر و بدون بخش مجاز)
  if (!me.isAdmin && me.sections.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-sm w-full">
          <CardContent className="p-6 text-center space-y-3">
            <ShieldOff className="h-10 w-10 text-destructive/60 mx-auto" />
            <h2 className="font-bold">دسترسی فعال نیست</h2>
            <p className="text-xs text-muted-foreground leading-6">
              حساب شما ساخته شده است اما مدیر هنوز دسترسی بخش‌های برنامه را برای شما تعیین نکرده است.
              لطفاً با مدیر سیستم تماس بگیرید.
            </p>
            <button onClick={logoutAndReload} className="text-xs text-primary font-bold underline underline-offset-4">
              خروج و ورود با حساب دیگر
            </button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const renderView = () => {
    switch (view) {
      case "dashboard":
        return <Dashboard />;
      case "customers":
        return <CustomersView />;
      case "customer-profile":
        return <CustomerProfile />;
      case "products":
        return <ProductsView />;
      case "orders":
        return <OrdersView />;
      case "order-form":
        return <OrderForm />;
      case "order-edit":
        // ویرایش فاکتور — همان فرم صدور با حالت ویرایش (params.orderId)
        return <OrderForm />;
      case "order-detail":
        return <OrderDetail />;
      case "reports":
        return <ReportsView />;
      case "catalogs":
        return <CatalogView />;
      case "users":
        return <UsersView />;
      case "backup":
        // پشتیبان‌گیری فقط مدیر — محافظت کلاینت (سرور هم مستقل بررسی می‌کند)
        return me.isAdmin ? <BackupView /> : <Dashboard />;
      case "license-sales":
        // فروش لایسنس — فقط سازنده برنامه (سرور هم مستقل محافظت می‌کند)
        return me.isOwner ? <LicenseSalesView /> : <Dashboard />;
      case "settings":
        return <SettingsView />;
      default:
        return <Dashboard />;
    }
  };

  return <Shell>{renderView()}</Shell>;
}

function logoutAndReload() {
  // ابطال سمت سرور (کوکی خودکار فرستاده می‌شود) و پاک‌سازی کامل + توکن پشتیبان
  saveFallbackToken(null);
  const clear = () => location.reload();
  fetch("/api/auth/logout", { method: "POST" }).catch(() => {}).finally(clear);
}
