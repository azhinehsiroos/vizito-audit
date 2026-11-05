"use client";

import { create } from "zustand";

export type ViewKey =
  | "dashboard"
  | "customers"
  | "customer-profile"
  | "products"
  | "orders"
  | "order-form"
  | "order-edit"
  | "order-detail"
  | "reports"
  | "catalogs"
  | "users"
  | "messages" // صندوق پیام — همه کاربران
  | "support" // پشتیبانی داخلی — کاربران مجموعه‌دار
  | "owner-messages" // پیام‌ها و اطلاع‌رسانی — فقط سازنده برنامه
  | "backup"
  | "license-sales"
  | "super-admin" // پنل مدیریت کل — فقط سازنده برنامه (SUPER_ADMIN)
  | "settings";

export type Me = {
  id: string;
  mobile: string;
  name: string;
  company: string | null;
  role: string;
  sections: string[];
  grantExpiresAt: string | null; // null = دائمی/مدیر
  isAdmin: boolean;
  isOwner?: boolean; // سازنده برنامه — دسترسی به بخش فروش لایسنس
  kind?: string; // STAFF (پرسنل) | PUBLIC (کاربر عمومی)
  orgName?: string | null; // نام مجموعه کاربر — null برای سازنده/حساب‌های قدیمی
  licenseLocked?: boolean; // آیا این کاربر با قفل لایسنس مواجه است (سمت سرور تصمیم‌گیری می‌شود)
  trialUntil?: string | null; // ترِیال شخصی کاربر عمومی
};

/** پیش‌نویس فاکتور هنگام صدور از پروفایل مشتری — انتخاب کالاها منتقل می‌شود */
export type InvoiceDraft = {
  customerId: string;
  selections: Record<string, { quantity: number; offer: string }>;
} | null;

type AppState = {
  view: ViewKey;
  params: Record<string, string>;
  me: Me | null;
  authLoading: boolean;
  menuOpen: boolean;
  logo: string | null; // لوگوی سفارشی برند (از تنظیمات) — null یعنی لوگوی پیش‌فرض
  invoiceDraft: InvoiceDraft;
  /** حالت آفلاین — true یعنی دستگاه بدون شبکه است و داده از اسنپ‌شات محلی خوانده می‌شود */
  online: boolean;
  /** اپ از اسنپ‌شات آفلاین بوت شده (حتی اگر اتصال برگشته هنوز ری‌استارت نشده) */
  offlineBooted: boolean;
  /** تعداد سفارش‌های آفلاین در انتظار همگام‌سازی */
  pendingOrders: number;
  setOnline: (v: boolean) => void;
  setOfflineBooted: (v: boolean) => void;
  setPendingOrders: (n: number) => void;
  setView: (view: ViewKey, params?: Record<string, string>) => void;
  setMe: (me: Me | null) => void;
  setAuthLoading: (v: boolean) => void;
  setMenuOpen: (v: boolean) => void;
  setLogo: (logo: string | null) => void;
  setInvoiceDraft: (d: InvoiceDraft) => void;
  can: (section: string) => boolean;
};

export const useApp = create<AppState>((set, get) => ({
  view: "dashboard",
  params: {},
  me: null,
  authLoading: true,
  menuOpen: false,
  logo: null,
  invoiceDraft: null,
  online: true,
  offlineBooted: false,
  pendingOrders: 0,
  setOnline: (online) => set({ online }),
  setOfflineBooted: (offlineBooted) => set({ offlineBooted }),
  setPendingOrders: (pendingOrders) => set({ pendingOrders }),
  setView: (view, params = {}) => set({ view, params, menuOpen: false }),
  setMe: (me) => set({ me }),
  setAuthLoading: (authLoading) => set({ authLoading }),
  setMenuOpen: (menuOpen) => set({ menuOpen }),
  setLogo: (logo) => set({ logo }),
  setInvoiceDraft: (invoiceDraft) => set({ invoiceDraft }),
  can: (section) => {
    const me = get().me;
    if (!me) return false;
    if (me.isAdmin) return true;
    return me.sections.includes(section);
  },
}));
