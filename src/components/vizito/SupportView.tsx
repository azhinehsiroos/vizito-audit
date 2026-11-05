"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { formatJalaliDateTime, toFa } from "@/lib/jalali";
import { toast } from "@/hooks/use-toast";
import {
  outboxEnqueue,
  outboxList,
  outboxRemove,
  type SupportOutboxItem,
} from "@/lib/idb";
import {
  LifeBuoy,
  RefreshCw,
  ArrowRight,
  Send,
  Plus,
  Clock,
  CheckCheck,
  MessageSquare,
  Phone,
  Send as TelegramIcon,
  WifiOff,
} from "lucide-react";

/**
 * پشتیبانی داخلی — سمت مجموعه (بخش چهارم سند طراحی SaaS)
 * -----------------------------------------------------------------------------
 * - ساخت رشته (موضوع: عمومی/خرید لایسنس/تمدید) + گفتگوی دوطرفه با سازنده
 * - شناسه مجموعه سمت سرور از نشست پیوست می‌شود — کلاینت هیچ orgId نمی‌فرستد
 * - قطعی اینترنت: پیام در صف محلی (IndexedDB) با «در انتظار ارسال»؛ تا ack سرور
 *   (ثبت clientRef) از صف حذف نمی‌شود و پس از اتصال خودکار ارسال می‌شود
 * - مسیر جایگزین: شماره تماس/تلگرام سازنده (از تنظیمات سازنده)
 */

type ThreadRow = {
  id: string;
  subjectType: string;
  subjectLabel: string;
  status: string;
  unreadForOrg: boolean;
  messagesCount: number;
  lastMessageAt: string;
  createdAt: string;
  lastMessage: { body: string; senderSide: string; createdAt: string } | null;
};

type MessageRow = {
  id: string;
  senderSide: "ORG" | "VENDOR";
  senderName: string;
  body: string;
  createdAt: string;
};

const STATUS_BADGE: Record<string, string> = {
  OPEN: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-0",
  ANSWERED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border-0",
  CLOSED: "bg-secondary text-secondary-foreground border-0",
};

const SUBJECT_ITEMS = [
  { key: "GENERAL", label: "پشتیبانی عمومی" },
  { key: "BUY_LICENSE", label: "خرید لایسنس" },
  { key: "RENEW", label: "تمدید لایسنس" },
];

const BODY_MAX = 4000;

/** UUID امن — کلید ضدتکرار پیام (ضد درج دوباره در همگام‌سازی آفلاین) */
function newClientRef(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // جایگزین v4 — WebView بسیار قدیمی
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function SupportView() {
  const [threads, setThreads] = useState<ThreadRow[] | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [contacts, setContacts] = useState<{ telegram: string; phone: string }>({ telegram: "", phone: "" });

  const refreshPending = useCallback(async () => {
    const items = await outboxList();
    setPendingCount(items.length);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ threads: ThreadRow[]; unread: number }>("/api/support/threads");
      setThreads(res.threads);
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
      setThreads([]);
    } finally {
      setLoading(false);
    }
    await refreshPending();
  }, [refreshPending]);

  useEffect(() => {
    void load();
    fetch("/api/license/pricing", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setContacts({ telegram: String(d?.telegram || ""), phone: String(d?.phone || "") }))
      .catch(() => {});
  }, [load]);

  // تخلیه خودکار صف پس از بازگشت اتصال
  useEffect(() => {
    const onOnline = () => void load();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [load]);

  if (openId) {
    return (
      <ThreadDetail
        threadId={openId}
        onBack={() => {
          setOpenId(null);
          void load();
        }}
        onQueuedChange={refreshPending}
      />
    );
  }

  return (
    <div className="space-y-3 app-fade">
      <div className="flex items-center justify-between gap-2">
        <h1 className="font-bold text-lg flex items-center gap-2">
          <LifeBuoy className="h-5 w-5 text-primary" /> پشتیبانی
        </h1>
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => void load()} aria-label="بارگذاری مجدد">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <p className="text-[11px] text-muted-foreground leading-5 px-1">
        درخواست‌ها و پیام‌های شما مستقیماً برای سازندهٔ برنامه ارسال می‌شود؛ پاسخ همین‌جا نمایش داده می‌شود. این گفتگو
        حتی در پایان مهلت یا تعلیق حساب هم باز است.
      </p>

      {/* صف آفلاین */}
      {pendingCount > 0 && (
        <Card className="border-amber-300/70 dark:border-amber-500/40">
          <CardContent className="p-2.5 flex items-center gap-2 text-[11px]">
            <WifiOff className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <span className="flex-1">
              {toFa(pendingCount)} پیام در انتظار ارسال است — با بازگشت اینترنت خودکار ارسال می‌شود.
            </span>
          </CardContent>
        </Card>
      )}

      {/* گفتگوی جدید */}
      <NewThreadCard
        onCreated={(id) => {
          setOpenId(id);
          void load();
        }}
        onQueued={refreshPending}
      />

      {/* فهرست گفتگوها */}
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      ) : !threads || threads.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center space-y-2">
            <MessageSquare className="h-8 w-8 text-muted-foreground/50 mx-auto" />
            <p className="text-sm font-medium">هنوز گفتگویی ندارید</p>
            <p className="text-[11px] text-muted-foreground">برای سؤال یا درخواست، گفتگوی جدید بسازید</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {threads.map((t) => (
            <Card key={t.id} className={t.unreadForOrg ? "border-primary/40" : ""}>
              <CardContent className="p-0">
                <button
                  type="button"
                  onClick={() => setOpenId(t.id)}
                  className="w-full text-right p-3 space-y-1"
                  aria-label={`گفتگو: ${t.subjectLabel}`}
                >
                  <span className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-bold text-sm">{t.subjectLabel}</span>
                    <Badge className={`text-[9px] ${STATUS_BADGE[t.status] || ""}`}>
                      {t.status === "OPEN" ? "در انتظار پاسخ" : t.status === "ANSWERED" ? "پاسخ داده شد" : "بسته شده"}
                    </Badge>
                    {t.unreadForOrg && (
                      <Badge className="text-[9px] bg-primary text-primary-foreground border-0">پاسخ جدید</Badge>
                    )}
                  </span>
                  {t.lastMessage && (
                    <span className="block text-[11px] text-muted-foreground truncate">
                      {t.lastMessage.senderSide === "VENDOR" ? "پشتیبانی: " : "شما: "}
                      {t.lastMessage.body}
                    </span>
                  )}
                  <span className="block text-[10px] text-muted-foreground/80">
                    {formatJalaliDateTime(t.lastMessageAt)} • {toFa(t.messagesCount)} پیام
                  </span>
                </button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* مسیر جایگزین — شماره تماس/تلگرام سازنده */}
      {(contacts.phone || contacts.telegram) && (
        <Card>
          <CardContent className="p-3 space-y-1.5">
            <div className="text-[11px] font-bold text-muted-foreground">مسیرهای جایگزین تماس (اگر به پاسخ نرسیدید)</div>
            <div className="flex flex-wrap gap-1.5">
              {contacts.phone && (
                <Button size="sm" variant="outline" className="h-8 text-[11px] gap-1.5" onClick={() => (window.location.href = `tel:${contacts.phone}`)}>
                  <Phone className="h-3.5 w-3.5" />
                  <span dir="ltr">{toFa(contacts.phone)}</span>
                </Button>
              )}
              {contacts.telegram && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-[11px] gap-1.5"
                  onClick={() => window.open(`https://t.me/${contacts.telegram.trim().replace(/^@/, "")}`, "_blank", "noopener,noreferrer")}
                >
                  <TelegramIcon className="h-3.5 w-3.5" />
                  تلگرام
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ─────────────────────── گفتگوی جدید ─────────────────────── */

function NewThreadCard({ onCreated, onQueued }: { onCreated: (threadId: string) => void; onQueued: () => void }) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("GENERAL");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const clientRef = newClientRef();
    const payload = { subjectType: subject, body: text.trim(), clientRef };
    // اول در صف محلی — تا ack سرور حذف نمی‌شود (قطعی اینترنت هم پیام نمی‌سوزد)
    await outboxEnqueue({ clientRef, threadId: "", subjectType: subject, body: text.trim(), createdAt: new Date().toISOString() });
    try {
      const res = await api<{ thread: { id: string } }>("/api/support/threads", { method: "POST", body: payload });
      await outboxRemove(clientRef);
      toast({ title: "گفتگو ثبت شد ✅", description: "پاسخ سازنده همین‌جا نمایش داده می‌شود" });
      setText("");
      setOpen(false);
      onCreated(res.thread.id);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status && status < 500 && status !== 429) {
        // خطای اعتبارسنجی — پیام مشکل‌دار از صف حذف می‌شود (ارسال مجدد بی‌فایده است)
        await outboxRemove(clientRef);
        toast({ title: "ثبت نشد", description: (e as Error).message, variant: "destructive" });
      } else {
        // قطعی شبکه/سرور — در صف می‌ماند و خودکار ارسال می‌شود
        toast({ title: "آفلاین", description: "پیام در صف ارسال ذخیره شد — با بازگشت اینترنت خودکار ارسال می‌شود" });
        onQueued();
        setText("");
        setOpen(false);
      }
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button className="w-full gap-1.5" size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> گفتگوی جدید
      </Button>
    );
  }

  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">موضوع</Label>
          <Select value={subject} onValueChange={setSubject}>
            <SelectTrigger className="h-9 text-[12px]" aria-label="موضوع گفتگو">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUBJECT_ITEMS.map((s) => (
                <SelectItem key={s.key} value={s.key} className="text-[12px]">
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="support-new-body" className="text-[11px] text-muted-foreground">
            متن پیام
          </Label>
          <Textarea
            id="support-new-body"
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, BODY_MAX))}
            placeholder="درخواست یا سؤال خود را بنویسید…"
            className="min-h-24 text-[12px]"
          />
          <div className="text-[10px] text-muted-foreground text-left">{toFa(text.length)} / {toFa(BODY_MAX)}</div>
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" onClick={submit} disabled={busy || !text.trim()}>
            {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            ارسال
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            بستن
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─────────────────────── جزئیات گفتگو ─────────────────────── */

function ThreadDetail({
  threadId,
  onBack,
  onQueuedChange,
}: {
  threadId: string;
  onBack: () => void;
  onQueuedChange: () => void;
}) {
  const [thread, setThread] = useState<{ subjectLabel: string; status: string } | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [pending, setPending] = useState<SupportOutboxItem[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const endRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{
        thread: { subjectLabel: string; status: string };
        messages: MessageRow[];
      }>(`/api/support/threads/${threadId}`);
      setThread({ subjectLabel: res.thread.subjectLabel, status: res.thread.status });
      setMessages(res.messages);
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
    const items = (await outboxList()).filter((i) => i.threadId === threadId);
    setPending(items);
  }, [threadId]);

  useEffect(() => {
    void load();
  }, [load]);

  // تخلیه خودکار صف با بازگشت اتصال + ارسال مجدد هنگام ورود به گفتگو
  useEffect(() => {
    const flush = async () => {
      const items = await outboxList();
      if (items.length === 0) return;
      let didSend = false;
      for (const item of items.filter((i) => i.threadId === threadId)) {
        try {
          await api(`/api/support/threads/${threadId}`, {
            method: "POST",
            body: { body: item.body, clientRef: item.clientRef },
          });
          await outboxRemove(item.clientRef);
          didSend = true;
        } catch {
          break; // هنوز قطع است — صف می‌ماند
        }
      }
      if (didSend) {
        await load();
        onQueuedChange();
      }
    };
    void flush();
    window.addEventListener("online", flush);
    return () => window.removeEventListener("online", flush);
  }, [threadId, load, onQueuedChange]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, pending.length]);

  const send = async () => {
    const bodyText = text.trim();
    if (!bodyText || busy) return;
    setBusy(true);
    const clientRef = newClientRef();
    // اول صف محلی (تا ack سرور حذف نمی‌شود) + نمایش خوش‌بینانه «در انتظار ارسال»
    await outboxEnqueue({
      clientRef,
      threadId,
      subjectType: "GENERAL",
      body: bodyText,
      createdAt: new Date().toISOString(),
    });
    setPending((p) => [
      ...p,
      { clientRef, threadId, subjectType: "GENERAL", body: bodyText, createdAt: new Date().toISOString() },
    ]);
    setText("");
    try {
      await api(`/api/support/threads/${threadId}`, { method: "POST", body: { body: bodyText, clientRef } });
      await outboxRemove(clientRef);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status && status < 500 && status !== 429) {
        await outboxRemove(clientRef);
        setPending((p) => p.filter((i) => i.clientRef !== clientRef));
        toast({ title: "ارسال نشد", description: (e as Error).message, variant: "destructive" });
      } else {
        toast({ title: "آفلاین", description: "پیام در صف ارسال ذخیره شد — با بازگشت اینترنت خودکار ارسال می‌شود" });
      }
    } finally {
      setBusy(false);
      await load();
      onQueuedChange();
    }
  };

  return (
    <div className="space-y-3 app-fade">
      <div className="flex items-center gap-2">
        <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={onBack} aria-label="بازگشت">
          <ArrowRight className="h-4 w-4 rotate-180" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="font-bold text-sm flex items-center gap-1.5 flex-wrap">
            {thread?.subjectLabel || "گفتگو"}
            {thread && <Badge className={`text-[9px] ${STATUS_BADGE[thread.status] || ""}`}>{thread.status === "OPEN" ? "در انتظار پاسخ" : thread.status === "ANSWERED" ? "پاسخ داده شد" : "بسته شده"}</Badge>}
          </div>
        </div>
        <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={() => void load()} aria-label="بارگذاری مجدد">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-3/4 rounded-xl" />
          <Skeleton className="h-14 w-2/3 rounded-xl" />
        </div>
      ) : (
        <Card>
          <CardContent className="p-3 space-y-2 max-h-[55dvh] overflow-y-auto">
            {messages.map((m) => {
              const mine = m.senderSide === "ORG";
              return (
                <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[85%] rounded-2xl px-3 py-2 text-[12px] leading-6 ${
                      mine
                        ? "bg-primary text-primary-foreground rounded-br-md"
                        : "bg-secondary text-secondary-foreground rounded-bl-md"
                    }`}
                  >
                    <div className="whitespace-pre-wrap break-words">{m.body}</div>
                    <div className={`text-[9px] mt-1 ${mine ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                      {mine ? "شما" : "پشتیبانی"} • {formatJalaliDateTime(m.createdAt)}
                    </div>
                  </div>
                </div>
              );
            })}
            {pending.map((p) => (
              <div key={p.clientRef} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl px-3 py-2 text-[12px] leading-6 bg-primary/15 text-foreground border border-dashed border-primary/40 rounded-br-md">
                  <div className="whitespace-pre-wrap break-words opacity-80">{p.body}</div>
                  <div className="text-[9px] mt-1 text-amber-600 dark:text-amber-400 flex items-center gap-1">
                    <Clock className="h-3 w-3" /> در انتظار ارسال
                  </div>
                </div>
              </div>
            ))}
            <div ref={endRef} />
          </CardContent>
        </Card>
      )}

      {/* ارسال پیام — حتی روی گفتگوی بسته مجاز است (بازگشایی خودکار سمت سرور) */}
      <Card>
        <CardContent className="p-2.5 space-y-2">
          <Textarea
            id="support-reply-body"
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, BODY_MAX))}
            placeholder="پیام خود را بنویسید…"
            className="min-h-16 text-[12px]"
            aria-label="متن پیام"
          />
          <div className="flex items-center justify-between gap-2">
            <div className="text-[10px] text-muted-foreground">
              {text.length > 0 && `${toFa(text.length)} / ${toFa(BODY_MAX)}`}
            </div>
            <Button size="sm" onClick={send} disabled={busy || !text.trim()} className="gap-1.5">
              {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              ارسال
            </Button>
          </div>
          {pending.length > 0 && (
            <div className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
              <Clock className="h-3 w-3" /> {toFa(pending.length)} پیام در انتظار ارسال — پس از اتصال خودکار می‌رود
              <CheckCheck className="h-3 w-3 opacity-0" />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
