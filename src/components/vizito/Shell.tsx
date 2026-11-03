"use client";

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
import { api, saveFallbackToken } from "@/lib/api";
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
  const { view, setView, me, menuOpen, setMenuOpen, setMe } = useApp();

  const available = SECTIONS.filter((s) => {
    if (s.key === "users") return me?.isAdmin;
    return me ? me.isAdmin || me.sections.includes(s.key) : false;
  });

  const bottomItems: { key: ViewKey; label: string; icon: React.ComponentType<{ className?: string }>; section: string }[] = [
    { key: "dashboard", label: "خانه", icon: House, section: "dashboard" },
    { key: "customers", label: "مشتریان", icon: Users, section: "customers" },
    { key: "products", label: "کالاها", icon: Package, section: "products" },
    { key: "orders", label: "سفارشات", icon: ClipboardList, section: "orders" },
  ];

  const navigate = (key: ViewKey) => {
    setView(key);
  };

  const logout = () => {
    // ابطال سمت سرور نشست (کوکی HttpOnly پاک می‌شود) + پاک‌سازی سمت کلاینت + توکن پشتیبان
    api("/api/auth/logout", { method: "POST" }).catch(() => {});
    saveFallbackToken(null);
    setMe(null);
    setMenuOpen(false);
    setView("dashboard");
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

      {/* محتوا */}
      <main className="flex-1 max-w-3xl w-full mx-auto px-3 pt-4 pb-28">{children}</main>

      {/* منوی پایین (فوتر ثابت) */}
      <footer className="fixed bottom-0 inset-x-0 z-40 bg-background/95 backdrop-blur border-t border-border/70 pb-[env(safe-area-inset-bottom)]">
        <div className="max-w-3xl mx-auto grid grid-cols-5">
          {bottomItems.map((item) => {
            const active = view === item.key;
            return (
              <button
                key={item.key}
                onClick={() => navigate(item.key)}
                className={`flex flex-col items-center gap-0.5 py-2 text-[10px] transition-colors ${
                  active ? "text-primary font-bold" : "text-muted-foreground hover:text-foreground"
                }`}
                aria-label={item.label}
              >
                <item.icon className={`h-5 w-5 ${active ? "stroke-[2.4]" : ""}`} />
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
