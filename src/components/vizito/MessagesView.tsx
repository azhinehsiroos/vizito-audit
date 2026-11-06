"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatJalali, toFa } from "@/lib/jalali";
import { useApp } from "@/lib/store";
import { toast } from "@/hooks/use-toast";
import { Mail, MailOpen, Star, RefreshCw, Inbox } from "lucide-react";

/** صندوق پیام — پیام‌های دریافتی هر کاربر از مالک برنامه */
type InboxMessage = {
  id: string;
  title: string;
  body: string | null;
  important: boolean;
  senderName: string;
  createdAt: string;
  readAt: string | null;
};

export function MessagesView() {
  const { setView } = useApp();
  const [messages, setMessages] = useState<InboxMessage[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ messages: InboxMessage[]; unread: number }>("/api/messages");
      setMessages(res.messages);
      setUnread(res.unread);
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openMessage = async (m: InboxMessage) => {
    if (!m.readAt) {
      try {
        await api(`/api/messages/${m.id}/read`, { method: "POST" });
        setMessages((prev) =>
          prev
            ? prev.map((x) => (x.id === m.id ? { ...x, readAt: new Date().toISOString() } : x))
            : prev
        );
        setUnread((u) => Math.max(0, u - 1));
      } catch {
        // ثبت خوانده‌شدن ناموفق — نمایش ادامه می‌یابد
      }
    }
    setOpenId(openId === m.id ? null : m.id);
  };

  return (
    <div className="space-y-3 app-fade">
      <div className="flex items-center justify-between gap-2">
        <h1 className="font-bold text-lg flex items-center gap-2">
          <Mail className="h-5 w-5 text-primary" /> پیام‌ها
          {unread > 0 && (
            <Badge className="text-[10px] bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-0">
              {toFa(unread)} خوانده‌نشده
            </Badge>
          )}
        </h1>
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => void load()} aria-label="بارگذاری مجدد">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      ) : !messages || messages.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center space-y-2">
            <Inbox className="h-8 w-8 text-muted-foreground/50 mx-auto" />
            <p className="text-sm font-medium">پیامی دریافت نشده است</p>
            <p className="text-[11px] text-muted-foreground">پیام‌های سازنده برنامه اینجا نمایش داده می‌شوند</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {messages.map((m) => {
            const open = openId === m.id;
            return (
              <Card
                key={m.id}
                className={
                  m.important
                    ? "border-amber-300/70 dark:border-amber-500/40"
                    : !m.readAt
                      ? "border-primary/30"
                      : ""
                }
              >
                <CardContent className="p-3">
                  <button
                    type="button"
                    onClick={() => void openMessage(m)}
                    className="w-full text-right flex items-start gap-2"
                    aria-expanded={open}
                  >
                    <span className="mt-0.5 shrink-0">
                      {m.readAt ? (
                        <MailOpen className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <Mail className="h-4 w-4 text-primary" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 flex-wrap">
                        <span className={!m.readAt ? "font-bold text-sm" : "font-medium text-sm"}>
                          {m.title}
                        </span>
                        {m.important && (
                          <Badge className="text-[9px] gap-0.5 bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-0">
                            <Star className="h-2.5 w-2.5" /> مهم
                          </Badge>
                        )}
                        {!m.readAt && (
                          <Badge variant="secondary" className="text-[9px]">
                            جدید
                          </Badge>
                        )}
                      </span>
                      <span className="block text-[10px] text-muted-foreground mt-0.5">
                        {m.senderName} • {formatJalali(m.createdAt)}
                      </span>
                      {open && m.body && (
                        <span className="block text-xs leading-6 mt-2 whitespace-pre-wrap border-t border-dashed border-border pt-2">
                          {m.body}
                        </span>
                      )}
                      {!open && m.body && (
                        <span className="block text-[11px] text-muted-foreground truncate mt-1">{m.body}</span>
                      )}
                    </span>
                  </button>
                </CardContent>
              </Card>
            );
          })}
          <Button variant="ghost" size="sm" className="w-full text-[11px] text-muted-foreground" onClick={() => setView("dashboard")}>
            بازگشت به داشبورد
          </Button>
        </div>
      )}
    </div>
  );
}
