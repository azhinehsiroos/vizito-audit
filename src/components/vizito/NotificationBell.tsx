"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff, Info, MessageSquare, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import { formatJalali, toFa } from "@/lib/jalali";

type VizitoNotification = {
  id: string;
  title: string;
  body: string | null;
  type: "CATALOG" | "NOTE" | "SYSTEM";
  readAt: string | null;
  createdAt: string;
};

const TYPE_META: Record<string, { icon: React.ComponentType<{ className?: string }>; label: string }> = {
  CATALOG: { icon: Package, label: "کاتالوگ" },
  NOTE: { icon: MessageSquare, label: "یادداشت" },
  SYSTEM: { icon: Info, label: "سیستم" },
};

/**
 * زنگ اعلان‌ها — نمایش آخرین ۵۰ اعلان کاربر + شمارنده خوانده‌نشده
 * بدون نشست (کاربر واردنشده) کاملاً بی‌اثر است (هیچ رکوئیتی زده نمی‌شود)
 */
export function NotificationBell() {
  const { me } = useApp();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<VizitoNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const markingRef = useRef(false);

  const fetchNotifications = useCallback(async () => {
    if (!me) return;
    try {
      const data = await api<{ notifications: VizitoNotification[]; unread: number }>(
        "/api/notifications"
      );
      setNotifications(data.notifications || []);
      setUnread(data.unread || 0);
      setLoaded(true);
    } catch {
      // خطاهای polling بی‌صدا نادیده گرفته می‌شوند (چرخه بعدی دوباره تلاش می‌کند)
    }
  }, [me]);

  // بارگذاری اولیه + تکرار هر ۴۵ ثانیه — فقط وقتی کاربر وارد شده است
  useEffect(() => {
    if (!me) return;
    void fetchNotifications();
    const id = setInterval(() => void fetchNotifications(), 45000);
    return () => clearInterval(id);
  }, [me, fetchNotifications]);

  // باز شدن پنل → علامت‌گذاری همه به‌عنوان خوانده‌شده (وقتی خوانده‌نشده داریم)
  const markAllRead = useCallback(async () => {
    if (markingRef.current || unread <= 0) return;
    markingRef.current = true;
    try {
      await api("/api/notifications", { method: "POST", body: {} });
      const now = new Date().toISOString();
      setNotifications((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt: now })));
      setUnread(0);
    } catch {
      // بی‌صدا — در باز شدن بعدی دوباره تلاش می‌شود
    } finally {
      markingRef.current = false;
    }
  }, [unread]);

  if (!me) return null;

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) void markAllRead();
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative shrink-0" aria-label="اعلان‌ها">
          <Bell className="h-5 w-5" />
          {unread > 0 && (
            <span className="absolute -top-1 -left-1 min-w-4 h-4 px-1 rounded-full bg-destructive text-white text-[9px] font-bold flex items-center justify-center leading-none pointer-events-none">
              {toFa(unread > 99 ? "99+" : unread)}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" dir="rtl" className="w-80 max-w-[92vw] p-0">
        <div className="flex items-center justify-between px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-xs font-bold">
            <Bell className="h-3.5 w-3.5 text-primary" />
            اعلان‌ها
          </div>
          {unread > 0 && (
            <span className="text-[9px] font-bold rounded-full bg-destructive/10 text-destructive px-2 py-0.5">
              {toFa(unread)} خوانده‌نشده
            </span>
          )}
        </div>
        <Separator />
        <div className="max-h-80 overflow-y-auto">
          {!loaded ? (
            <p className="text-xs text-muted-foreground text-center py-8">در حال بارگذاری…</p>
          ) : notifications.length === 0 ? (
            <div className="py-10 text-center space-y-2">
              <BellOff className="h-7 w-7 text-muted-foreground/40 mx-auto" />
              <p className="text-xs text-muted-foreground">اعلانی ندارید</p>
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {notifications.map((n) => {
                const meta = TYPE_META[n.type] || TYPE_META.SYSTEM;
                const Icon = meta.icon;
                const isUnread = !n.readAt;
                return (
                  <li
                    key={n.id}
                    className={`flex items-start gap-2.5 px-3 py-2.5 ${isUnread ? "bg-primary/5" : ""}`}
                  >
                    <span className="shrink-0 mt-0.5 h-7 w-7 rounded-lg bg-secondary/60 flex items-center justify-center">
                      <Icon className="h-3.5 w-3.5 text-primary" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-bold text-xs leading-snug">{n.title}</span>
                        {isUnread && (
                          <span
                            className="shrink-0 mt-1.5 h-1.5 w-1.5 rounded-full bg-primary"
                            aria-hidden
                          />
                        )}
                      </div>
                      {n.body && (
                        <p className="text-[11px] text-muted-foreground line-clamp-2 leading-5 mt-0.5">
                          {n.body}
                        </p>
                      )}
                      <div className="text-[10px] text-muted-foreground/80 mt-1">
                        {formatJalali(n.createdAt)}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
