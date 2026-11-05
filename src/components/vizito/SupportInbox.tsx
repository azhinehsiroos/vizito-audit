"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { formatJalaliDateTime, toFa, toEnDigits } from "@/lib/jalali";
import { toast } from "@/hooks/use-toast";
import {
  LifeBuoy,
  RefreshCw,
  ArrowRight,
  Send,
  Search,
  Building2,
  Inbox,
  CheckCheck,
  XCircle,
} from "lucide-react";

/**
 * صندوق پشتیبانی سازنده — بخش چهارم سند طراحی (تب «پشتیبانی» در پنل مدیریت کل)
 * -----------------------------------------------------------------------------
 * - فهرست همه رشته‌ها با نام مجموعه + مدیر + موضوع + وضعیت + نشان نخوانده
 * - جست‌وجو (نام مجموعه/مدیر/موبایل) + فیلتر وضعیت/موضوع/فقط‌نخوانده + صفحه‌بندی
 * - گفتگوی دوطرفه + پاسخ + تعیین وضعیت (پاسخ داده شد / بستن / بازکردن)
 * هر مشاهده/عملیات سمت سرور در AdminAccessLog ثبت می‌شود.
 */

type InboxThread = {
  id: string;
  subjectType: string;
  subjectLabel: string;
  status: string;
  unreadForVendor: boolean;
  messagesCount: number;
  lastMessageAt: string;
  createdAt: string;
  org: { id: string; name: string; status: string; admin: { name: string; mobile: string } | null };
  lastMessage: { body: string; senderSide: string; createdAt: string } | null;
};

type InboxResp = {
  threads: InboxThread[];
  total: number;
  page: number;
  pageSize: number;
  summary: { total: number; open: number; answered: number; closed: number; unread: number };
};

type DetailResp = {
  thread: {
    id: string;
    subjectLabel: string;
    status: string;
    createdAt: string;
    org: { id: string; name: string; status: string; admin: { name: string; mobile: string } | null };
  };
  messages: { id: string; senderSide: "ORG" | "VENDOR"; senderName: string; body: string; createdAt: string }[];
};

const STATUS_BADGE: Record<string, string> = {
  OPEN: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-0",
  ANSWERED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border-0",
  CLOSED: "bg-secondary text-secondary-foreground border-0",
};
const STATUS_FA: Record<string, string> = { OPEN: "در انتظار پاسخ", ANSWERED: "پاسخ داده شد", CLOSED: "بسته شده" };

export function SupportInbox() {
  const [openId, setOpenId] = useState<string | null>(null);
  if (openId) return <ThreadAdminDetail threadId={openId} onBack={() => setOpenId(null)} />;
  return <InboxList onOpen={setOpenId} />;
}

/* ─────────────────────── فهرست صندوق ─────────────────────── */

function InboxList({ onOpen }: { onOpen: (id: string) => void }) {
  const [data, setData] = useState<InboxResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [subject, setSubject] = useState("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ page: String(page), pageSize: "20" });
      if (q.trim()) p.set("q", q.trim());
      if (status !== "all") p.set("status", status);
      if (subject !== "all") p.set("subject", subject);
      if (unreadOnly) p.set("unread", "1");
      const res = await api<InboxResp>(`/api/sa/support?${p.toString()}`);
      setData(res);
    } catch (e) {
      toast({ title: (e as Error).message || "خطا در دریافت صندوق" });
    } finally {
      setLoading(false);
    }
  }, [q, status, subject, unreadOnly, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const s = data?.summary;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-3">
      {/* جمع‌بندی */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: "کل گفتگوها", value: s?.total },
          { label: "در انتظار", value: s?.open, cls: "text-amber-600 dark:text-amber-400" },
          { label: "نخوانده", value: s?.unread, cls: "text-rose-600 dark:text-rose-400" },
        ].map((it) => (
          <Card key={it.label}>
            <CardContent className="p-2 text-center">
              <div className={`text-sm font-black ${it.cls || ""}`}>{it.value === undefined ? "—" : toFa(it.value)}</div>
              <div className="text-[9px] text-muted-foreground">{it.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* جست‌وجو و فیلتر */}
      <Card>
        <CardContent className="p-2.5 space-y-2">
          <div className="relative">
            <Search className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => {
                setQ(toEnDigits(e.target.value));
                setPage(1);
              }}
              placeholder="جست‌وجو: مجموعه، مدیر، موبایل…"
              className="h-9 text-[12px] pr-8"
              aria-label="جست‌وجوی گفتگو"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
              <SelectTrigger className="h-8 text-[11px]" aria-label="فیلتر وضعیت">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-[11px]">همه وضعیت‌ها</SelectItem>
                <SelectItem value="OPEN" className="text-[11px]">در انتظار پاسخ</SelectItem>
                <SelectItem value="ANSWERED" className="text-[11px]">پاسخ داده شد</SelectItem>
                <SelectItem value="CLOSED" className="text-[11px]">بسته شده</SelectItem>
              </SelectContent>
            </Select>
            <Select value={subject} onValueChange={(v) => { setSubject(v); setPage(1); }}>
              <SelectTrigger className="h-8 text-[11px]" aria-label="فیلتر موضوع">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-[11px]">همه موضوع‌ها</SelectItem>
                <SelectItem value="GENERAL" className="text-[11px]">پشتیبانی عمومی</SelectItem>
                <SelectItem value="BUY_LICENSE" className="text-[11px]">خرید لایسنس</SelectItem>
                <SelectItem value="RENEW" className="text-[11px]">تمدید لایسنس</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between">
            <Button
              size="sm"
              variant={unreadOnly ? "default" : "outline"}
              className="h-7 text-[10px] gap-1"
              onClick={() => {
                setUnreadOnly((v) => !v);
                setPage(1);
              }}
            >
              <Inbox className="h-3 w-3" /> فقط نخوانده‌ها
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void load()} aria-label="بارگذاری مجدد">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* فهرست */}
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      ) : !data || data.threads.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center space-y-2">
            <LifeBuoy className="h-8 w-8 text-muted-foreground/50 mx-auto" />
            <p className="text-sm font-medium">گفتگویی وجود ندارد</p>
            <p className="text-[11px] text-muted-foreground">پیام‌های پشتیبانی مجموعه‌ها اینجا نمایش داده می‌شود</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {data.threads.map((t) => (
            <Card key={t.id} className={t.unreadForVendor ? "border-primary/40" : ""}>
              <CardContent className="p-0">
                <button type="button" onClick={() => onOpen(t.id)} className="w-full text-right p-3 space-y-1" aria-label={`گفتگو: ${t.org.name}`}>
                  <span className="flex items-center gap-1.5 flex-wrap">
                    <Building2 className="h-3.5 w-3.5 text-primary shrink-0" />
                    <span className="font-bold text-sm">{t.org.name}</span>
                    <Badge className={`text-[9px] ${STATUS_BADGE[t.status] || ""}`}>{STATUS_FA[t.status] || t.status}</Badge>
                    {t.unreadForVendor && (
                      <Badge className="text-[9px] bg-primary text-primary-foreground border-0">پیام جدید</Badge>
                    )}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {t.subjectLabel} • مدیر: {t.org.admin?.name || "—"}
                    {t.org.admin ? ` (${toFa(t.org.admin.mobile)})` : ""}
                  </span>
                  {t.lastMessage && (
                    <span className="block text-[11px] text-muted-foreground truncate">
                      {t.lastMessage.senderSide === "ORG" ? "مجموعه: " : "شما: "}
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
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-1">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="h-8 text-[11px]">
                قبلی
              </Button>
              <span className="text-[11px] text-muted-foreground">
                صفحه {toFa(page)} از {toFa(totalPages)}
              </span>
              <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="h-8 text-[11px]">
                بعدی
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────── گفتگوی سازنده با مجموعه ─────────────────────── */

function ThreadAdminDetail({ threadId, onBack }: { threadId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<DetailResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<DetailResp>(`/api/sa/support/${threadId}`);
      setDetail(res);
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    void load();
  }, [load]);

  const reply = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await api(`/api/sa/support/${threadId}`, { method: "POST", body: { action: "reply", body } });
      setText("");
      toast({ title: "پاسخ ارسال شد ✅" });
      await load();
    } catch (e) {
      toast({ title: "ارسال نشد", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (status: string) => {
    try {
      await api(`/api/sa/support/${threadId}`, { method: "POST", body: { action: "status", status } });
      toast({ title: "وضعیت گفتگو به‌روزرسانی شد" });
      await load();
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    }
  };

  const t = detail?.thread;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={onBack} aria-label="بازگشت">
          <ArrowRight className="h-4 w-4 rotate-180" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="font-bold text-sm flex items-center gap-1.5 flex-wrap">
            <Building2 className="h-3.5 w-3.5 text-primary shrink-0" />
            {t?.org.name || "گفتگو"}
            {t && <Badge className={`text-[9px] ${STATUS_BADGE[t.status] || ""}`}>{STATUS_FA[t.status] || t.status}</Badge>}
          </div>
          {t?.org.admin && (
            <div className="text-[10px] text-muted-foreground">
              {t.org.admin.name} • {toFa(t.org.admin.mobile)}
            </div>
          )}
        </div>
        <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={() => void load()} aria-label="بارگذاری مجدد">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {t && (
        <div className="flex flex-wrap gap-1.5">
          {t.status !== "ANSWERED" && (
            <Button size="sm" variant="outline" className="h-7 text-[10px] gap-1" onClick={() => void setStatus("ANSWERED")}>
              <CheckCheck className="h-3 w-3" /> پاسخ داده شد
            </Button>
          )}
          {t.status !== "CLOSED" && (
            <Button size="sm" variant="outline" className="h-7 text-[10px] gap-1" onClick={() => void setStatus("CLOSED")}>
              <XCircle className="h-3 w-3" /> بستن گفتگو
            </Button>
          )}
          {t.status !== "OPEN" && (
            <Button size="sm" variant="outline" className="h-7 text-[10px] gap-1" onClick={() => void setStatus("OPEN")}>
              <Inbox className="h-3 w-3" /> بازگشایی
            </Button>
          )}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-3/4 rounded-xl" />
          <Skeleton className="h-14 w-2/3 rounded-xl" />
        </div>
      ) : (
        <Card>
          <CardContent className="p-3 space-y-2 max-h-[50dvh] overflow-y-auto">
            {detail?.messages.map((m) => {
              const mine = m.senderSide === "VENDOR";
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
                      {m.senderName} • {formatJalaliDateTime(m.createdAt)}
                    </div>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-2.5 space-y-2">
          <Label htmlFor="sa-reply-body" className="text-[11px] text-muted-foreground">
            پاسخ شما (برای مجموعه نمایش داده می‌شود)
          </Label>
          <Textarea
            id="sa-reply-body"
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, 4000))}
            placeholder="پاسخ خود را بنویسید…"
            className="min-h-16 text-[12px]"
          />
          <div className="flex items-center justify-between">
            <div className="text-[10px] text-muted-foreground">{text.length > 0 && `${toFa(text.length)} / ۴۰۰۰`}</div>
            <Button size="sm" onClick={reply} disabled={busy || !text.trim()} className="gap-1.5">
              {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              ارسال پاسخ
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
