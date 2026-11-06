"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { JalaliCalendar } from "@/components/vizito/JalaliCalendar";
import { useApp } from "@/lib/store";
import { api } from "@/lib/api";
import { readSnapshot, mirror } from "@/lib/offline";
import { formatMoney, formatJalaliLong, expiryLabel, toFa } from "@/lib/jalali";
import { Users, Package, ClipboardList, Wallet, Plus, UserPlus, PackagePlus, BookOpen, CloudOff, ShieldCheck } from "lucide-react";

type Summary = {
  customerCount: number;
  productCount: number;
  groupCount: number;
  orderCount: number;
  totalSales: number;
  monthSales: number;
  topCustomers: { customerId: string; count: number; total: number }[];
  lastOrders: { id: string; totalAmount: number; createdAt: string; customerId: string; itemCount: number }[];
};

export function Dashboard() {
  const { setView, me, online } = useApp();
  const [summary, setSummary] = useState<Summary | null>(null);
  // M1 (اصلاح فاز B): حساب سازنده — آمار «مجموعه‌ای» معنی ندارد؛ هدایت به پنل مدیریت کل
  const isSuperView = !!(me?.isOwner || me?.role === "SUPER_ADMIN");

  useEffect(() => {
    api<Summary>("/api/reports/summary")
      .then((s) => {
        setSummary(s);
        // آینه‌سازی — داشبورد آفلاین با آخرین خلاصه شناخته‌شده
        void mirror("summary", s);
      })
      .catch(async () => {
        // قطعی/مسدود — اسنپ‌شات آخرین همگام‌سازی
        const snap = await readSnapshot<Summary>("summary");
        setSummary(snap ? snap.value : null);
      });
  }, []);

  const stats = [
    { label: "مشتریان", value: summary?.customerCount, icon: Users, view: "customers" as const },
    { label: "کالاها", value: summary?.productCount, icon: Package, view: "products" as const },
    { label: "سفارشات", value: summary?.orderCount, icon: ClipboardList, view: "orders" as const },
  ];

  const quickActions = [
    { label: "مشتری جدید", icon: UserPlus, view: "customers" as const },
    { label: "ثبت کالا", icon: PackagePlus, view: "products" as const },
    { label: "سفارش جدید", icon: Plus, view: "orders" as const },
    { label: "کاتالوگ", icon: BookOpen, view: "catalogs" as const },
  ];

  return (
    <div className="space-y-4 app-fade">
      {/* اطلاع آفلاین — بخش ۵.۲ سند: داشبورد از آخرین همگام‌سازی */}
      {!online && (
        <div
          role="status"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px] text-amber-800 dark:text-amber-300 flex items-center gap-2"
        >
          <CloudOff className="h-4 w-4 shrink-0" />
          <span>حالت آفلاین — آمار از آخرین همگام‌سازی دستگاه؛ سفارش‌های جدید پس از اتصال در آمار دیده می‌شوند.</span>
        </div>
      )}
      {/* خوش‌آمد */}
      <Card className="border-primary/20 bg-gradient-to-l from-primary/10 via-card to-card">
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="font-bold text-lg leading-snug">
                سلام {me?.name?.split(" ")[0] || "کاربر"} عزیز 👋
              </h2>
              <p className="text-xs text-muted-foreground mt-1">
                {formatJalaliLong(new Date())} — امروز چه سفارشی داریم؟
              </p>
              {me && !me.isAdmin && me.grantExpiresAt && (
                <Badge variant="secondary" className="mt-2 text-[10px]">
                  اعتبار دسترسی: {expiryLabel(me.grantExpiresAt)}
                </Badge>
              )}
            </div>
            <Wallet className="h-8 w-8 text-primary/50" />
          </div>
        </CardContent>
      </Card>

      {/* M1: نمای اختصاصی سازنده — بدون آمار تجاری مجموعه‌ای */}
      {isSuperView ? (
        <Card className="border-primary/30">
          <CardContent className="p-5 text-center space-y-3">
            <ShieldCheck className="h-10 w-10 text-primary/60 mx-auto" />
            <h3 className="font-bold">پنل مدیریت کل فعال است</h3>
            <p className="text-xs text-muted-foreground leading-6">
              مدیریت مجموعه‌ها، لایسنس‌ها، پشتیبانی و گزارش‌های کل سیستم از همین‌جا انجام می‌شود.
              داده تجاری هر مجموعه فقط از مسیر مدیریتی و با ثبت حسابرسی قابل مشاهده است.
            </p>
            <Button size="sm" onClick={() => setView("super-admin")}>
              <ShieldCheck className="h-4 w-4" />
              ورود به مدیریت کل
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* آمار */}
          <div className="grid grid-cols-3 gap-2">
            {stats.map((s) => (
              <button key={s.label} onClick={() => setView(s.view)} className="text-right">
                <Card className="hover:border-primary/40 transition-colors h-full">
                  <CardContent className="p-3">
                    <s.icon className="h-4 w-4 text-primary mb-2" />
                    {s.value === undefined ? (
                      <Skeleton className="h-6 w-12" />
                    ) : (
                      <div className="text-lg font-black leading-none">{formatMoney(s.value)}</div>
                    )}
                    <div className="text-[10px] text-muted-foreground mt-1">{s.label}</div>
                  </CardContent>
                </Card>
              </button>
            ))}
          </div>

          {/* فروش */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Wallet className="h-4 w-4 text-primary" /> خلاصه فروش
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">مجموع فروش کل</span>
                <span className="font-bold">{formatMoney(summary?.totalSales)} تومان</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">فروش ۳۰ روز اخیر</span>
                <span className="font-bold text-primary">{formatMoney(summary?.monthSales)} تومان</span>
              </div>
            </CardContent>
          </Card>

          {/* تقویم شمسی */}
          <Card>
            <CardHeader className="pb-0">
              <CardTitle className="text-sm">تقویم هجری شمسی</CardTitle>
            </CardHeader>
            <JalaliCalendar compact />
          </Card>

          {/* دسترسی سریع */}
          <div className="grid grid-cols-4 gap-2">
            {quickActions.map((a) => (
              <Button
                key={a.label}
                variant="secondary"
                className="flex flex-col gap-1 h-auto py-3 text-[10px] font-medium"
                onClick={() => setView(a.view)}
              >
                <a.icon className="h-4 w-4 text-primary" />
                {a.label}
              </Button>
            ))}
          </div>

          {/* آخرین سفارش‌ها */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">آخرین سفارش‌ها</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {!summary?.lastOrders?.length ? (
                <p className="text-xs text-muted-foreground text-center py-4">هنوز سفارشی ثبت نشده است</p>
              ) : (
                summary.lastOrders.map((o) => (
                  <div
                    key={o.id}
                    className="flex items-center justify-between text-xs bg-secondary/50 rounded-lg px-3 py-2"
                  >
                    <span className="font-medium">سفارش #{toFa(o.itemCount)} قلم کالا</span>
                    <span className="text-muted-foreground">{formatJalaliLong(o.createdAt)}</span>
                    <span className="font-bold text-primary">{formatMoney(o.totalAmount)}</span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
