"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { formatJalali, toFa } from "@/lib/jalali";
import type { AppUser } from "@/lib/types";
import { toast } from "@/hooks/use-toast";
import {
  Megaphone,
  Send,
  Loader2,
  Trash2,
  Eye,
  Star,
  ShieldAlert,
  ShieldCheck,
  Users,
} from "lucide-react";

type SentMessage = {
  id: string;
  audience: string;
  title: string;
  body: string | null;
  important: boolean;
  senderName: string;
  createdAt: string;
  deleted: boolean;
  recipientCount: number;
  readCount: number;
};

const AUDIENCE_OPTIONS: { key: string; label: string }[] = [
  { key: "ALL", label: "همه کاربران" },
  { key: "ADMINS", label: "مدیران (خریداران لایسنس)" },
  { key: "STAFF", label: "پرسنل شرکت‌ها" },
  { key: "BUYERS", label: "خریداران لایسنس (دفتر فروش)" },
  { key: "SALE_EXPIRING", label: "لایسنس نزدیک به انقضا (۱۴ روز)" },
  { key: "SALE_EXPIRED", label: "لایسنس منقضی‌شده" },
  { key: "SALE_GRACE", label: "در مهلت تمدید ۳۰ روزه" },
  { key: "USER", label: "یک کاربر مشخص" },
];

type LifecycleInfo = {
  phase: string;
  paused: boolean;
  pausedBySetting?: boolean;
  graceDaysLeft: number | null;
  deletedAt: string | null;
};

const PHASE_LABELS: Record<string, string> = {
  FRESH: "نصب تازه",
  OWNER_UNLOCKED: "دسترسی مالک فعال",
  OK: "لایسنس معتبر",
  NOT_ACTIVATED: "لایسنس فعال نشده",
  GRACE: "در مهلت تمدید ۳۰ روزه",
  SWEEP_DUE: "پایان مهلت — در انتظار حذف کنترل‌شده",
  DELETED: "داده‌ها حذف شده‌اند (لاگ موجود است)",
};

/** پنل «پیام‌ها و اطلاع‌رسانی» — فقط سازنده برنامه (مالک اصلی) */
export function OwnerMessagesView() {
  const [messages, setMessages] = useState<SentMessage[] | null>(null);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [life, setLife] = useState<LifecycleInfo | null>(null);
  const [lifeBusy, setLifeBusy] = useState(false);

  // فرم ارسال
  const [audience, setAudience] = useState("ALL");
  const [targetUser, setTargetUser] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [important, setImportant] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);

  // جزئیات پیام
  const [detail, setDetail] = useState<{
    message: SentMessage;
    recipients: { userId: string; name: string; mobile: string; role: string; readAt: string | null }[];
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [m, u, l] = await Promise.all([
        api<{ messages: SentMessage[] }>("/api/admin/messages"),
        api<AppUser[]>("/api/users").catch(() => [] as AppUser[]),
        api<LifecycleInfo>("/api/admin/lifecycle").catch(() => null),
      ]);
      setMessages(m.messages);
      setUsers(u);
      setLife(l);
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

  const send = async () => {
    if (!title.trim()) {
      toast({ title: "خطا", description: "عنوان پیام الزامی است", variant: "destructive" });
      return;
    }
    if (audience === "USER" && !targetUser) {
      toast({ title: "خطا", description: "کاربر مقصد را انتخاب کنید", variant: "destructive" });
      return;
    }
    setSending(true);
    try {
      const res = await api<{ recipientCount: number }>("/api/admin/messages", {
        method: "POST",
        body: {
          audience,
          userId: audience === "USER" ? targetUser : null,
          title: title.trim(),
          body: body.trim() || null,
          important,
        },
      });
      toast({ title: "پیام ارسال شد ✅", description: `${toFa(res.recipientCount)} گیرنده` });
      setSendOpen(false);
      setTitle("");
      setBody("");
      setImportant(false);
      load();
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  const removeMessage = async (m: SentMessage) => {
    if (!confirm(`پیام «${m.title}» حذف شود؟ از صندوق کاربران پنهان می‌شود.`)) return;
    try {
      await api(`/api/admin/messages/${m.id}`, { method: "DELETE" });
      toast({ title: "پیام حذف شد" });
      load();
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    }
  };

  const openDetail = async (m: SentMessage) => {
    try {
      const res = await api<{
        message: SentMessage;
        recipients: { userId: string; name: string; mobile: string; role: string; readAt: string | null }[];
      }>(`/api/admin/messages/${m.id}`);
      setDetail(res);
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    }
  };

  const lifecycleAction = async (action: "sweep" | "pause" | "resume") => {
    if (action === "sweep" && !confirm("حذف کنترل‌شده داده‌ها اجرا شود؟ (فقط اگر مهلت تمام شده باشد)")) return;
    setLifeBusy(true);
    try {
      await api("/api/admin/lifecycle", { method: "POST", body: { action } });
      toast({ title: "انجام شد ✅" });
      load();
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setLifeBusy(false);
    }
  };

  const audienceLabel = (key: string) => AUDIENCE_OPTIONS.find((a) => a.key === key)?.label ?? key;

  return (
    <div className="space-y-3 app-fade">
      <div className="flex items-center justify-between gap-2">
        <h1 className="font-bold text-lg flex items-center gap-2">
          <Megaphone className="h-5 w-5 text-primary" /> پیام‌ها و اطلاع‌رسانی
        </h1>
        <Button size="sm" onClick={() => setSendOpen(true)}>
          <Send className="h-4 w-4" /> ارسال پیام
        </Button>
      </div>

      {/* چرخه حیات داده — مشاهده و کنترل حذف خودکار (فقط مالک) */}
      {life && (
        <Card>
          <CardContent className="p-3 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                {life.phase === "SWEEP_DUE" && !life.paused ? (
                  <ShieldAlert className="h-4 w-4 text-destructive" />
                ) : (
                  <ShieldCheck className="h-4 w-4 text-emerald-600" />
                )}
                <span className="text-xs font-bold">
                  چرخه حیات داده: {PHASE_LABELS[life.phase] ?? life.phase}
                </span>
                {life.graceDaysLeft !== null && (
                  <Badge variant="secondary" className="text-[9px]">
                    {toFa(life.graceDaysLeft)} روز تا پایان مهلت
                  </Badge>
                )}
                {life.paused && (
                  <Badge className="text-[9px] bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-0">
                    حذف خودکار متوقف شده
                  </Badge>
                )}
              </div>
              <div className="flex gap-1.5">
                {life.paused ? (
                  <Button size="sm" variant="secondary" className="h-7 text-[11px]" disabled={lifeBusy} onClick={() => void lifecycleAction("resume")}>
                    ادامه حذف خودکار
                  </Button>
                ) : (
                  life.phase !== "OK" && (
                    <Button size="sm" variant="secondary" className="h-7 text-[11px]" disabled={lifeBusy} onClick={() => void lifecycleAction("pause")}>
                      توقف حذف خودکار
                    </Button>
                  )
                )}
                {life.phase === "SWEEP_DUE" && !life.paused && (
                  <Button size="sm" variant="destructive" className="h-7 text-[11px]" disabled={lifeBusy} onClick={() => void lifecycleAction("sweep")}>
                    <Trash2 className="h-3 w-3" /> اجرای حذف
                  </Button>
                )}
              </div>
            </div>
            {life.deletedAt && (
              <p className="text-[10px] text-muted-foreground">
                آخرین حذف کنترل‌شده: {formatJalali(life.deletedAt)} — جزئیات کامل در لاگ سرور و نسخه پشتیبان پیش از حذف
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* تاریخچه پیام‌ها */}
      {loading ? (
        <Skeleton className="h-32 w-full rounded-xl" />
      ) : !messages || messages.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center">
            <Users className="h-8 w-8 text-muted-foreground/50 mx-auto mb-2" />
            <p className="text-sm font-medium">هنوز پیامی ارسال نکرده‌اید</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {messages.map((m) => (
            <Card key={m.id} className={m.deleted ? "opacity-60" : m.important ? "border-amber-300/70 dark:border-amber-500/40" : ""}>
              <CardContent className="p-3 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-bold text-sm">{m.title}</span>
                      {m.important && (
                        <Badge className="text-[9px] gap-0.5 bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-0">
                          <Star className="h-2.5 w-2.5" /> مهم
                        </Badge>
                      )}
                      {m.deleted && (
                        <Badge variant="destructive" className="text-[9px]">
                          حذف‌شده
                        </Badge>
                      )}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      {audienceLabel(m.audience)} • {formatJalali(m.createdAt)}
                    </div>
                    {m.body && <p className="text-[11px] text-muted-foreground truncate mt-1">{m.body}</p>}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-primary" onClick={() => void openDetail(m)} aria-label="مشاهده گیرندگان">
                      <Eye className="h-3.5 w-3.5" />
                    </Button>
                    {!m.deleted && (
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => void removeMessage(m)} aria-label="حذف پیام">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <Badge variant="secondary" className="text-[9px]">{toFa(m.recipientCount)} گیرنده</Badge>
                  <Badge variant="secondary" className="text-[9px]">{toFa(m.readCount)} خوانده‌شده</Badge>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* دیالوگ ارسال پیام */}
      <Dialog open={sendOpen} onOpenChange={setSendOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>ارسال پیام</DialogTitle>
            <DialogDescription>پیام شما در صندوق پیام گیرندگان نمایش داده می‌شود</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>مخاطب *</Label>
              <Select value={audience} onValueChange={setAudience}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUDIENCE_OPTIONS.map((a) => (
                    <SelectItem key={a.key} value={a.key}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {audience === "USER" && (
                <Select value={targetUser} onValueChange={setTargetUser}>
                  <SelectTrigger className="mt-1.5">
                    <SelectValue placeholder="انتخاب کاربر" />
                  </SelectTrigger>
                  <SelectContent>
                    {users.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.name} — {toFa(u.mobile)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>عنوان *</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثلاً تخفیف ویژه تمدید لایسنس" />
            </div>
            <div className="space-y-1.5">
              <Label>متن پیام</Label>
              <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="متن پیام (اختیاری)" />
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox checked={important} onCheckedChange={(v) => setImportant(v === true)} />
              پیام مهم (با نشان برجسته نمایش داده می‌شود)
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSendOpen(false)} disabled={sending}>انصراف</Button>
            <Button onClick={() => void send()} disabled={sending}>
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} ارسال
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* دیالوگ جزئیات — گیرندگان و وضعیت خوانده‌شدن */}
      <Dialog open={!!detail} onOpenChange={(v) => !v && setDetail(null)}>
        <DialogContent className="max-h-[80dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>گیرندگان — {detail?.message.title}</DialogTitle>
            <DialogDescription>
              {detail ? `${toFa(detail.recipients.length)} گیرنده — ${toFa(detail.recipients.filter((r) => r.readAt).length)} خوانده‌شده` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 max-h-[50dvh] overflow-y-auto">
            {detail?.recipients.map((r) => (
              <div key={r.userId} className="flex items-center justify-between gap-2 border rounded-lg p-2 text-xs">
                <div className="min-w-0">
                  <div className="font-medium truncate">{r.name}</div>
                  <div className="text-[10px] text-muted-foreground" dir="ltr">{toFa(r.mobile)}</div>
                </div>
                {r.readAt ? (
                  <Badge variant="secondary" className="text-[9px] shrink-0">خوانده شد — {formatJalali(r.readAt)}</Badge>
                ) : (
                  <Badge variant="outline" className="text-[9px] shrink-0">خوانده‌نشده</Badge>
                )}
              </div>
            ))}
            {detail && detail.recipients.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-4">گیرنده‌ای ثبت نشده است</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
