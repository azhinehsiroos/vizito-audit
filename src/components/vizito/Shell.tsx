"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Logo } from "@/components/vizito/Logo";
import { NotificationBell } from "@/components/vizito/NotificationBell";
import { useApp, type ViewKey } from "@/lib/store";
import { formatJalaliLong, expiryLabel, toFa } from "@/lib/jalali";
import { SECTIONS } from "@/lib/sections";
import { api } from "@/lib/api";
import { performLogout } from "@/components/vizito/VizitoApp";
import {
  LayoutDashboard,
  Users,
  Package,
  ClipboardList,
  BarChart3,
  BookOpen,
  UserCog,
  Settings,
  DatabaseBackup,
  Moon,
  Sun,
  Menu as MenuIcon,
  LogOut,
  Crown,
  House,
  Gem,
  Mail,
  Megaphone,
  ShieldCheck,
  LifeBuoy,
  CloudOff,
} from "lucide-react";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  LayoutDashboard,
  Users,
  Package,
  ClipboardList,
  BarChart3,
  BookOpen,
  UserCog,
};

export function Shell({ children }: { children: React.ReactNode }) {
  const { theme, setTheme } = useTheme();
  const { view, setView, me, menuOpen, setMenuOpen, setMe, setPendingOrders, online, pendingOrders } = useApp();
  const [supportUnread, setSupportUnread] = useState(0);

  // نشان نخواندهٔ پشتیبانی — فقط کاربران مجموعه‌دار؛ بدون polling (در بازشدن منو)
  useEffect(() => {
    if (!menuOpen || !me?.orgName) return;
    api<{ unread: number }>("/api/support/threads")
      .then((r) => setSupportUnread(r.unread || 0))
      .catch(() => {});
  }, [menuOpen, me?.orgName]);

  // M1 (اصلاح فاز B): حساب سازنده (SUPER_ADMIN بدون مجموعه) آیتم‌های داده تجاری سازمانی
  // را در منو نمی‌بیند — داده مجموعه‌ها فقط از «مدیریت کل» (مسیرهای audited) قابل مشاهده است
  const isSuperView = !!me && (me.isOwner || me.role === "SUPER_ADMIN");
  const available = SECTIONS.filter((s) => {
    if (isSuperView && ["customers", "products", "orders", "reports", "catalogs", "users"].includes(s.key)) return false;
    if (s.key === "users") return me?.isAdmin;
    return me ? me.isAdmin || me.sections.includes(s.key) : false;
  });

  const bottomItems: { key: ViewKey; label: string; icon: React.ComponentType<{ className?: string }>; section: string }[] = (
    isSuperView
      ? [
          { key: "dashboard", label: "خانه", icon: House, section: "dashboard" },
        ]
      : [
          { key: "dashboard", label: "خانه", icon: House, section: "dashboard" },
          { key: "customers", label: "مشتریان", icon: Users, section: "customers" },
          { key: "products", label: "کالاها", icon: Package, section: "products" },
          { key: "orders", label: "سفارشات", icon: ClipboardList, section: "orders" },
        ]
  );

  const navigate = (key: ViewKey) => {
    setView(key);
  };

  const logout = () => {
    // C1 (اصلاح فاز A): خروج سفارش‌های همگام‌نشده را حذف نمی‌کند —
    // در صورت وجود صف، دیالوگ تأیید با شمارش دقیق نشان داده می‌شود
    void performLogout().then((done) => {
      if (!done) return; // کاربر انصراف داد — نشست و داده‌ها سر جایشان
      setMe(null);
      setMenuOpen(false);
      setView("dashboard");
      setPendingOrders(0);
    });
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* هدر */}
      <header className="sticky top-0 z-40 bg-background/85 backdrop-blur border-b border-border/70">
        <div className="max-w-3xl mx-auto flex items-center justify-between h-14 px-3">
          {/* سمت راست: دکمه منو (همبرگری) + لوگو */}
          <div className="flex items-center gap-2 min-w-0">
            <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="shrink-0" aria-label="منو">
                  <MenuIcon className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="right" aria-describedby={undefined} className="w-72 p-0">
                <SheetHeader className="p-4 pb-2 text-right">
                  <SheetTitle className="flex items-center gap-2 text-base">
                    <Logo size={28} className="rounded-md" />
                    ویزیتو
                  </SheetTitle>
                  <div className="text-xs text-muted-foreground font-normal">
                    {me?.name} {me?.company ? `— ${me.company}` : ""}
                    <div className="text-[10px] mt-0.5">{toFa(me?.mobile ?? "")}</div>
                  </div>
                </SheetHeader>
                <Separator />
                <nav className="p-2 flex-1 overflow-y-auto max-h-[calc(100dvh-220px)]">
                  {available.map((s) => {
                    const Icon = ICONS[s.icon] || LayoutDashboard;
                    return (
                      <button
                        key={s.key}
                        onClick={() => {
                          navigate(s.key as ViewKey);
                        }}
                        className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                          view === s.key
                            ? "bg-accent text-accent-foreground font-semibold"
                            : "hover:bg-accent/60"
                        }`}
                      >
                        <Icon className="h-4 w-4 text-primary" />
                        {s.label}
                      </button>
                    );
                  })}
                  {/* صندوق پیام — همه کاربران واردشده */}
                  {me && (
                    <button
                      onClick={() => navigate("messages")}
                      className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                        view === "messages" ? "bg-accent text-accent-foreground font-semibold" : "hover:bg-accent/60"
                      }`}
                    >
                      <Mail className="h-4 w-4 text-primary" />
                      پیام‌ها
                    </button>
                  )}
                  {/* پشتیبانی داخلی — کاربران مجموعه‌دار (حتی در قفل لایسنس در دسترس است) */}
                  {me?.orgName && (
                    <button
                      onClick={() => navigate("support")}
                      className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                        view === "support" ? "bg-accent text-accent-foreground font-semibold" : "hover:bg-accent/60"
                      }`}
                    >
                      <span className="relative">
                        <LifeBuoy className="h-4 w-4 text-primary" />
                        {supportUnread > 0 && (
                          <span
                            className="absolute -top-1 -left-1 h-2 w-2 rounded-full bg-rose-500"
                            aria-hidden="true"
                          />
                        )}
                      </span>
                      پشتیبانی
                      {supportUnread > 0 && (
                        <Badge className="text-[9px] bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300 border-0 mr-auto">
                          {toFa(supportUnread)} جدید
                        </Badge>
                      )}
                    </button>
                  )}
                  {/* پشتیبان‌گیری — فقط مدیر */}
                  {me?.isAdmin && (
                    <button
                      onClick={() => navigate("backup")}
                      className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                        view === "backup" ? "bg-accent text-accent-foreground font-semibold" : "hover:bg-accent/60"
                      }`}
                    >
                      <DatabaseBackup className="h-4 w-4 text-primary" />
                      پشتیبان‌گیری
                    </button>
                  )}
                  {/* فروش لایسنس — فقط سازنده برنامه */}
                  {me?.isOwner && (
                    <button
                      onClick={() => setView("license-sales")}
                      className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                        view === "license-sales" ? "bg-accent text-accent-foreground font-semibold" : "hover:bg-accent/60"
                      }`}
                    >
                      <Gem className="h-4 w-4 text-primary" />
                      فروش لایسنس
                    </button>
                  )}
                  {/* پنل مدیریت کل — فقط سازنده برنامه (SUPER_ADMIN) */}
                  {(me?.isOwner || me?.role === "SUPER_ADMIN") && (
                    <button
                      onClick={() => navigate("super-admin")}
                      className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                        view === "super-admin" ? "bg-accent text-accent-foreground font-semibold" : "hover:bg-accent/60"
                      }`}
                    >
                      <ShieldCheck className="h-4 w-4 text-primary" />
                      مدیریت کل
                    </button>
                  )}
                  {/* پیام‌ها و اطلاع‌رسانی — فقط سازنده برنامه (مالک اصلی) */}
                  {me?.isOwner && (
                    <button
                      onClick={() => navigate("owner-messages")}
                      className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                        view === "owner-messages" ? "bg-accent text-accent-foreground font-semibold" : "hover:bg-accent/60"
                      }`}
                    >
                      <Megaphone className="h-4 w-4 text-primary" />
                      پیام‌ها و اطلاع‌رسانی
                    </button>
                  )}
                  <button
                    onClick={() => navigate("settings")}
                    className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                      view === "settings" ? "bg-accent font-semibold" : "hover:bg-accent/60"
                    }`}
                  >
                    <Settings className="h-4 w-4 text-primary" />
                    تنظیمات
                  </button>
                </nav>
                <Separator />
                <div className="p-3">
                  {me && !me.isAdmin && me.grantExpiresAt && (
                    <div className="text-[11px] text-muted-foreground mb-2 rounded-lg bg-secondary/60 p-2">
                      اعتبار دسترسی: <span className="font-semibold">{expiryLabel(me.grantExpiresAt)}</span>
                    </div>
                  )}
                  <Button variant="destructive" className="w-full" size="sm" onClick={logout}>
                    <LogOut className="h-4 w-4" />
                    خروج از حساب
                  </Button>
                </div>
              </SheetContent>
            </Sheet>
            <Logo size={32} className="rounded-lg" />
            <div className="min-w-0">
              <div className="font-black text-base leading-tight">ویزیتو</div>
              <div className="text-[10px] text-muted-foreground truncate">{formatJalaliLong(new Date())}</div>
            </div>
            {me?.isAdmin && (
              <Badge variant="secondary" className="text-[9px] gap-1 bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-0">
                <Crown className="h-2.5 w-2.5" /> مدیر
              </Badge>
            )}
          </div>

          {/* سمت چپ: اعلان‌ها + حالت شب/روز */}
          <div className="flex items-center gap-1">
            {/* زنگ اعلان‌ها — برای کاربر واردشده (بدون توکن بی‌اثر است) */}
            <NotificationBell />
            <Button
              variant="ghost"
              size="icon"
              aria-label="تغییر حالت شب و روز"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              <Sun className="h-5 w-5 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
              <Moon className="absolute h-5 w-5 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
            </Button>
          </div>
        </div>
      </header>

      {/* بنر حالت آفلاین — بخش ۵.۲ سند: نمایش + سفارش‌گیری؛ عملیات مدیریتی قفل */}
      {!online && (
        <div
          role="status"
          className="sticky top-14 z-30 bg-amber-100/95 dark:bg-amber-950/90 border-b border-amber-300/60 dark:border-amber-800/60 text-amber-900 dark:text-amber-200"
        >
          <div className="max-w-3xl mx-auto px-3 py-1.5 flex items-center gap-2 text-[11px]">
            <CloudOff className="h-3.5 w-3.5 shrink-0" />
            <span className="font-semibold">حالت آفلاین</span>
            <span className="opacity-80 truncate">
              داده‌های آخرین همگام‌سازی نمایش داده می‌شود؛ سفارش‌ها پس از اتصال ثبت می‌شوند
            </span>
            {pendingOrders > 0 && (
              <Badge className="shrink-0 text-[9px] bg-amber-200 text-amber-900 dark:bg-amber-900 dark:text-amber-100 border-0">
                {toFa(pendingOrders)} سفارش در انتظار
              </Badge>
            )}
          </div>
        </div>
      )}

      {/* محتوا */}
      <main className="flex-1 max-w-3xl w-full mx-auto px-3 pt-4 pb-28">{children}</main>

      {/* منوی پایین (فوتر ثابت) */}
      <footer className="fixed bottom-0 inset-x-0 z-40 bg-background/95 backdrop-blur border-t border-border/70 pb-[env(safe-area-inset-bottom)]">
        <div className="max-w-3xl mx-auto grid grid-cols-5">
          {bottomItems.map((item) => {
            const active = view === item.key;
            const showPending = item.key === "orders" && pendingOrders > 0;
            return (
              <button
                key={item.key}
                onClick={() => navigate(item.key)}
                className={`relative flex flex-col items-center gap-0.5 py-2 text-[10px] transition-colors ${
                  active ? "text-primary font-bold" : "text-muted-foreground hover:text-foreground"
                }`}
                aria-label={showPending ? `${item.label} — ${toFa(pendingOrders)} سفارش در انتظار همگام‌سازی` : item.label}
              >
                <span className="relative">
                  <item.icon className={`h-5 w-5 ${active ? "stroke-[2.4]" : ""}`} />
                  {showPending && (
                    <span
                      className="absolute -top-1 -left-1.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-amber-500 text-white text-[8px] font-bold flex items-center justify-center"
                      aria-hidden="true"
                    >
                      {toFa(pendingOrders)}
                    </span>
                  )}
                </span>
                {item.label}
              </button>
            );
          })}
          <button
            onClick={() => setMenuOpen(true)}
            className="flex flex-col items-center gap-0.5 py-2 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            aria-label="بیشتر"
          >
            <MenuIcon className="h-5 w-5" />
            بیشتر
          </button>
        </div>
      </footer>
    </div>
  );
}
