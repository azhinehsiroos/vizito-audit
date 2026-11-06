"use client";

import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/lib/store";
import { api } from "@/lib/api";
import {
  isOnline,
  onConnectionChange,
  readMeSnapshot,
  readSnapshot,
  mirror,
  mirrorMe,
  offlineBypassAllowed,
  readCachedLicensePhase,
  type OfflineMe,
} from "@/lib/offline";
import { orderOutboxList, initLocalDbForUser, closeLocalDb, snapshotDelete } from "@/lib/idb";
import { runSync, cancelSyncSchedule, bumpSyncGeneration } from "@/lib/sync";
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
import { MessagesView } from "@/components/vizito/MessagesView";
import { OwnerMessagesView } from "@/components/vizito/OwnerMessagesView";
import { SettingsView } from "@/components/vizito/SettingsView";
import { BackupView } from "@/components/vizito/BackupView";
import { LicenseSalesView } from "@/components/vizito/LicenseSalesView";
import { SuperAdminView } from "@/components/vizito/SuperAdminView";
import { SupportView } from "@/components/vizito/SupportView";
import { LicenseScreen, type LicenseState } from "@/components/vizito/LicenseScreen";
import { Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { ShieldOff } from "lucide-react";
import { toFa } from "@/lib/jalali";

export function VizitoApp() {
  const {
    view,
    me,
    authLoading,
    online,
    offlineBooted,
    setOnline,
    setOfflineBooted,
    setMe,
    setAuthLoading,
    setLogo,
    setPendingOrders,
  } = useApp();
  const [license, setLicense] = useState<LicenseState | null>(null);
  const [licenseLoading, setLicenseLoading] = useState(true);

  const refreshPendingOrders = useCallback(async () => {
    try {
      const items = await orderOutboxList();
      setPendingOrders(items.length);
    } catch {
      // بدون IndexedDB — صف آفلاین نیست
    }
  }, [setPendingOrders]);

  // یک دور همگام‌سازی کامل — نتیجه: شمارنده صف تازه می‌شود
  const syncNow = useCallback(async () => {
    if (!useApp.getState().me?.orgName) return; // همگام‌سازی مجموعه‌محور است
    await runSync(({ ordersRemaining }) => setPendingOrders(ordersRemaining));
    void refreshPendingOrders();
  }, [setPendingOrders, refreshPendingOrders]);

  const loadLicense = useCallback(async () => {
    try {
      const res = await fetch("/api/license/status", { cache: "no-store" });
      const state = (await res.json()) as LicenseState;
      setLicense(state);
      // آینه‌سازی برای ورود آفلاین (بخش ۵.۴ — تصمیم فقط بر اساس آخرین وضعیت سمت سرور)
      void mirror("license", state);
    } catch {
      // قطعی اینترنت — آخرین وضعیت شناخته‌شده از اسنپ‌شات
      const snap = await readSnapshot<LicenseState>("license");
      if (snap) setLicense(snap.value);
      else setLicense({ activated: false, valid: false, name: null, mobile: null, expiresAt: null, daysLeft: null });
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

  // پس از ورود/تعویض حساب — شمارنده صف آفلاینِ «همین حساب» تازه می‌شود
  // (DB محلی per-حساب است؛ پیش از این، initLocalDbForUser اجرا شده است)
  useEffect(() => {
    if (meId) void refreshPendingOrders();
  }, [meId, refreshPendingOrders]);

  // ── اتصال/قطعی — وضعیت سراسری + واکنش بازگشت اتصال ──
  useEffect(() => {
    setOnline(isOnline());
    void refreshPendingOrders();
    return onConnectionChange((up) => {
      setOnline(up);
      if (up) {
        void refreshPendingOrders();
        // بازگشت اتصال — لایسنس/نشست دوباره از سرور (منبع حقیقت)
        void loadLicense();
        // اگر اپ از اسنپ‌شات آفلاین بوت شده بود — رفرش کامل تا داده آنلاین برگردد
        if (useApp.getState().offlineBooted) {
          window.location.reload();
        } else {
          // تخلیه صف‌های محلی (سفارش/پشتیبانی) + باندل تازه — بخش ۶.۱ سند
          void syncNow();
        }
      }
    });
  }, [setOnline, loadLicense, refreshPendingOrders, syncNow]);

  useEffect(() => {
    // بوت اصلی — همیشه اجرا می‌شود تا حتی در قفل لایسنس هم وضعیت کاربر مشخص شود:
    //  - کاربر بدون قفل (پرسنل در پایان ترِیال / مالک) وارد اپ می‌شود
    //  - کاربر قفل‌شده (مدیر در مهلت تمدید) صفحه وضعیت لایسنس را می‌بیند
    //  - قطعی اینترنت با اسنپ‌شات: ورود آفلاین (بخش ۵ سند — نمایش + سفارش‌گیری)
    if (!license) return;
    const boot = async () => {
      const onlineNow = isOnline();
      if (onlineNow) {
        // تنظیمات برند (لوگو) — عمومی و بدون نیاز به ورود
        try {
          const s = await api<{ logo: string | null }>("/api/settings");
          setLogo(s.logo);
          void mirror("settings", s);
        } catch {
          // لوگوی پیش‌فرض می‌ماند
        }
        // احراز هویت با کوکی HttpOnly — همیشه سمت سرور چک می‌شود (۴۰۱ ⇒ صفحه ورود)
        try {
          const res = await api<{
            user: { id: string; mobile: string; name: string; company: string | null; role: string; kind: string };
            sections: string[];
            grantExpiresAt: string | null;
            isAdmin: boolean;
            isOwner?: boolean;
            orgName?: string | null;
            licenseLocked?: boolean;
            trialUntil?: string | null;
          }>("/api/auth/me");
          const meObj: OfflineMe & { id: string } = {
            id: res.user.id,
            mobile: res.user.mobile,
            name: res.user.name,
            company: res.user.company,
            role: res.user.role,
            sections: res.sections,
            grantExpiresAt: res.grantExpiresAt,
            isAdmin: res.isAdmin,
            isOwner: !!res.isOwner,
            kind: res.user.kind,
            orgName: res.orgName ?? null,
            licenseLocked: !!res.licenseLocked,
            trialUntil: res.trialUntil ?? null,
          };
          // C1/H4: DB محلی به نام «همین حساب» پیش از ورود به اپ آماده می‌شود —
          // صف سفارش‌های همگام‌نشده قبلی همین حساب (در صورت وجود) بازمی‌گردد
          await initLocalDbForUser(meObj.id);
          setMe(meObj);
          setOfflineBooted(false);
          void mirrorMe(meObj);
          // ثبت هویت دستگاه (زیرساخت همگام‌سازی — بخش ۵.۱) — بی‌صدا، مانع بوت نیست
          if (meObj.orgName) {
            api("/api/device", { method: "POST", body: {} }).catch(() => {});
            // همگام‌سازی در بازشدن برنامه — بخش ۶.۱: باندل + تخلیه صف‌های محلی
            void syncNow();
          }
        } catch {
          // توکن نامعتبر است
        } finally {
          setAuthLoading(false);
        }
        return;
      }
      // ── بوت آفلاین ──
      // لوگو از اسنپ‌شات
      const settingsSnap = await readSnapshot<{ logo: string | null }>("settings");
      if (settingsSnap) setLogo(settingsSnap.value.logo);
      // نشست آخرین‌بار شناخته‌شده
      const cachedMe = await readMeSnapshot();
      if (!cachedMe) {
        // بدون اسنپ‌شات — صفحه ورود (ورود آفلاین ممکن نیست)
        setAuthLoading(false);
        return;
      }
      // سیاست ۵.۴: انقضای لایسنس/ترِیال در آفلاین ⇒ «نمایش + سفارش‌گیری + PDF» حفظ می‌شود؛
      // تعلیق مجموعه ⇒ فقط صفحه وضعیت (پشتیبانی هنگام اتصال)
      const phase = await readCachedLicensePhase();
      if (cachedMe.licenseLocked && !offlineBypassAllowed(phase)) {
        setAuthLoading(false);
        return;
      }
      // بوت آفلاین هم DB حساب خودش را پیش از ورود آماده می‌کند (صف‌ها/اسنپ‌شات همان حساب)
      await initLocalDbForUser(cachedMe.id);
      setMe(cachedMe);
      setOfflineBooted(true);
      setAuthLoading(false);
    };
    boot();
  }, [setMe, setAuthLoading, setLogo, setOfflineBooted, syncNow, license]);

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

  // قفل لایسنس — تصمیم سمت سرور (licenseLocked از /api/auth/me):
  //  - کاربر واردشده با معافیت (پرسنل در پایان ترِیال / ترِیال شخصی فعال / مالک) وارد اپ می‌شود
  //  - کاربر واردشده‌ی قفل‌شده صفحه وضعیت لایسنس را می‌بیند
  //  - بازدیدکننده بدون حساب: همیشه صفحه ورود/ثبت‌نام — ثبت‌نام آزاد است و به وضعیت لایسنس نصب وابسته نیست
  //    (ممیزی v1.1.4)؛ پس از ورود، اگر حسابش قفل باشد صفحه لایسنس را می‌بیند
  //  - نصب تازه — صفحه ورود/ثبت‌نام (بک‌اند ثبت‌نام اولین مدیر را مجاز می‌داند)
  //  - استثنای آفلاین (بخش ۵.۴ سند): در قطعی اینترنت با فاز «انقضا/پایان ترِیال» کاربر وارد اپ
  //    می‌شود (نمایش + سفارش‌گیری + PDF) — تصمیم بر اساس آخرین فاز شناخته‌شده سمت سرور
  const userLocked = me ? !!me.licenseLocked : false;
  const offlineExpiredEntry = !online && offlineBooted && offlineBypassAllowed(license?.phase);
  if (license && !license.valid && !license.freshInstall && (authLoading || userLocked) && !offlineExpiredEntry) {
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
      case "messages":
        // صندوق پیام — همه کاربران واردشده (سرور هم مستقل فیلتر می‌کند)
        return <MessagesView />;
      case "support":
        // پشتیبانی داخلی — کاربران مجموعه‌دار (سرور هم مستقل گیت می‌کند)
        return <SupportView />;
      case "owner-messages":
        // پیام‌ها و اطلاع‌رسانی — فقط سازنده برنامه (سرور هم مستقل محافظت می‌کند)
        return me.isOwner ? <OwnerMessagesView /> : <Dashboard />;
      case "backup":
        // پشتیبان‌گیری فقط مدیر — محافظت کلاینت (سرور هم مستقل بررسی می‌کند)
        return me.isAdmin ? <BackupView /> : <Dashboard />;
      case "license-sales":
        // فروش لایسنس — فقط سازنده برنامه (سرور هم مستقل محافظت می‌کند)
        return me.isOwner ? <LicenseSalesView /> : <Dashboard />;
      case "super-admin":
        // پنل مدیریت کل — فقط سازنده (SUPER_ADMIN)؛ سرور هم مستقل محافظت می‌کند
        return me.isOwner || me.role === "SUPER_ADMIN" ? <SuperAdminView /> : <Dashboard />;
      case "settings":
        return <SettingsView />;
      default:
        return <Dashboard />;
    }
  };

  return <Shell>{renderView()}</Shell>;
}

/**
 * خروج از حساب — بازطراحی فاز A (اصلاح C1/M7):
 * ❌ قبلاً: clearAllLocalData کل صف سفارش‌های همگام‌نشده را نابود می‌کرد.
 * ✅ حالا: هیچ داده‌ای حذف نمی‌شود؛ فقط چرخه sync در جریان بی‌اثر و آینه
 * نشست پاک می‌شود. DB محلی «per-حساب» است (idb.ts) — داده‌های این حساب فقط
 * با ورود مجدد «همین حساب» دوباره در دسترس‌اند و سپس خودکار همگام می‌شوند؛
 * حساب بعدی هرگز داده‌های حساب قبلی را نمی‌بیند (قانون ۶ مرحله ۸).
 */
export async function logoutLocalTeardown() {
  bumpSyncGeneration(); // M7 — چرخه sync در جریان پس از این مرحله بی‌اثر می‌شود
  cancelSyncSchedule(); // توقف زمان‌بند بک‌آف
  try {
    await snapshotDelete("me"); // فقط آینه نشست — بوت آفلاین بعدی به صفحه ورود می‌رود
  } catch {
    // بی‌خطر — خروج همچنان انجام می‌شود
  }
  closeLocalDb(); // reset اشاره‌گر DB — هر عملیات باقی‌مانده بی‌اثر می‌شود
}

/**
 * خروج کامل با دیالوگ تأیید هوشمند (C1):
 * اگر سفارش همگام‌نشده در صف باشد، کاربر با شمارش دقیق مطلع می‌شود که
 * سفارش‌ها «حذف نمی‌شوند» و پس از ورود مجدد با همان حساب ارسال خواهند شد.
 * خروجی: false یعنی کاربر انصراف داد.
 */
export async function performLogout(): Promise<boolean> {
  let pending = 0;
  try {
    pending = (await orderOutboxList()).length;
  } catch {
    pending = 0;
  }
  if (pending > 0) {
    const ok = window.confirm(
      `${toFa(pending)} سفارش همگام‌نشده روی این دستگاه دارید.\n\n` +
        `این سفارش‌ها با خروج از حساب حذف نمی‌شوند و پس از ورود مجدد با همین حساب، ` +
        `خودکار برای سرور ارسال می‌شوند.\n\n` +
        `خروج از حساب انجام شود؟`
    );
    if (!ok) return false;
  }
  // ابطال سمت سرور نشست — کوکی HttpOnly خودکار فرستاده و پاک می‌شود
  api("/api/auth/logout", { method: "POST" }).catch(() => {});
  await logoutLocalTeardown();
  return true;
}

function logoutAndReload() {
  // ابطال سمت سرور نشست + teardown محلی — سپس رفرش کامل
  const clear = () => location.reload();
  void performLogout()
    .catch(() => false)
    .finally(() => {
      setTimeout(clear, 0);
    });
}
