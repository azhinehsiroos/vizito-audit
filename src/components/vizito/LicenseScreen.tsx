"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  KeyRound,
  ShieldCheck,
  ShieldAlert,
  Clock3,
  DatabaseBackup,
  Send,
  Tags,
  Hourglass,
  Copy,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { formatJalali, toFa, formatMoney, toEnDigits } from "@/lib/jalali";
import { outboxEnqueue, outboxList, outboxRemove } from "@/lib/idb";
import { Textarea } from "@/components/ui/textarea";
import { Phone, LifeBuoy } from "lucide-react";

export type LicenseState = {
  activated: boolean;
  valid: boolean;
  name: string | null;
  mobile: string | null;
  expiresAt: string | null;
  daysLeft: number | null;
  ownerUnlocked?: boolean;
  trial?: boolean;
  permanent?: boolean;
  expiredAt?: string | null;
  graceUntil?: string | null;
  graceDaysLeft?: number | null;
  installId?: string | null;
  /** فاز قفل (TRIAL_OVER / LICENSE_EXPIRED / NOT_ACTIVATED / SUSPENDED) — برای پیام درست «پایان مهلت رایگان» */
  phase?: string | null;
  /** نصب تازه (هیچ حسابی نیست) — به‌جای این صفحه، صفحه ورود/ثبت‌نام مدیر اول نشان داده می‌شود */
  freshInstall?: boolean;
  /** چندمجموعه‌ای (SaaS): مجموعه کاربر واردشده — وضعیت لایسنس از مجموعه خوانده می‌شود */
  org?: { id: string; name: string; status: string } | null;
  orgSuspended?: boolean;
  trialEndsAt?: string | null;
};

type DurationKey = "m1" | "m3" | "m6" | "y1" | "perm";

type Pricing = {
  prices: Record<DurationKey, string>;
  telegram: string;
  phone?: string;
  durations: { key: DurationKey; label: string; days: number }[];
};

const DEFAULT_PRICING: Pricing = {
  prices: { m1: "", m3: "", m6: "", y1: "", perm: "" },
  telegram: "",
  durations: [
    { key: "m1", label: "۱ ماهه", days: 30 },
    { key: "m3", label: "۳ ماهه", days: 90 },
    { key: "m6", label: "۶ ماهه", days: 180 },
    { key: "y1", label: "۱ ساله", days: 365 },
    { key: "perm", label: "دائمی", days: 0 },
  ],
};

/** نمایش قیمت: اگر عدد باشد با جداکننده هزارگان و تومان، وگرنه همان متن */
function priceText(raw: string | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "تماس بگیرید";
  const num = Number(toEnDigits(s).replace(/[,\s٬]/g, ""));
  if (Number.isFinite(num) && num > 0) return `${formatMoney(num)} تومان`;
  return toFa(s);
}

/** شمارش معکوس دوره آزمایشی — هر ۳۰ ثانیه به‌روزرسانی می‌شود */
function useTrialCountdown(expiresAt: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return { over: true as const, hours: 0, minutes: 0 };
  return {
    over: false as const,
    hours: Math.floor(ms / 3_600_000),
    minutes: Math.floor((ms % 3_600_000) / 60_000),
  };
}

/**
 * صفحه قفل لایسنس — وقتی لایسنس فعال نیست یا منقضی شده، کل اپ با این صفحه بسته می‌شود.
 * این صفحه هم‌زمان یک صفحه فروش است: تعرفه‌ها، خرید از تلگرام و فعال‌سازی کلید.
 * نکته مهم برای کاربر: هیچ داده‌ای حذف نشده؛ با ورود کلید جدید (شارژ) همه‌چیز ادامه می‌یابد.
 */
export function LicenseScreen({ state, onActivated }: { state: LicenseState; onActivated: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [pricing, setPricing] = useState<Pricing>(DEFAULT_PRICING);
  const trial = useTrialCountdown(state.trial ? state.expiresAt : null);
  const expired = state.activated && !state.valid;
  // پایان مهلت استفاده رایگان (ترِیال) — پیام الزامی دستور کار (ممیزی v1.1.4)
  const trialOver = state.phase === "TRIAL_OVER";
  // تعلیق مجموعه توسط پشتیبانی (SaaS) — رفع آن فقط از سمت سازنده ممکن است
  const suspended = !!state.orgSuspended || state.phase === "SUSPENDED";

  // تعرفه‌های فروش — عمومی و بدون احراز هویت
  useEffect(() => {
    let alive = true;
    fetch("/api/license/pricing", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (alive && d && d.prices) setPricing({ ...DEFAULT_PRICING, ...d } as Pricing);
      })
      .catch(() => {
        /* تعرفه‌ها ناموفق — پیش‌فرض خالی */
      });
    return () => {
      alive = false;
    };
  }, []);

  const activate = async () => {
    if (!key.trim()) {
      toast({ title: "کد لایسنس را وارد کنید", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/license/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: key.trim() }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; name?: string; daysLeft?: number | null };
      if (!res.ok || !data.ok) {
        toast({ title: "فعال‌سازی نشد", description: data.error || "کلید نامعتبر است", variant: "destructive" });
        return;
      }
      toast({
        title: "لایسنس فعال شد ✅",
        description:
          data.daysLeft === null || data.daysLeft === undefined
            ? `${data.name || "ویزیتو"} — اعتبار دائمی`
            : `${data.name || "ویزیتو"} — ${toFa(data.daysLeft)} روز اعتبار`,
      });
      onActivated();
    } catch {
      toast({ title: "خطا", description: "ارتباط با سرور برقرار نشد", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const buyFromTelegram = () => {
    const id = pricing.telegram.trim().replace(/^@/, "");
    if (id) window.open(`https://t.me/${id}`, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-background to-primary/[0.06] p-4">
      <Card className="w-full max-w-sm border-primary/30 shadow-lg shadow-primary/5 max-h-[90dvh] overflow-y-auto">
        <CardContent className="p-6 space-y-4 text-center">
          <div className="mx-auto w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center">
            {expired ? (
              <ShieldAlert className="h-7 w-7 text-destructive" />
            ) : (
              <KeyRound className="h-7 w-7 text-primary" />
            )}
          </div>

          <div className="space-y-1">
            <h1 className="font-black text-lg">
              {suspended
                ? "مجموعه شما موقتاً متوقف شده است"
                : trialOver
                  ? "مهلت استفاده رایگان شما به پایان رسیده است"
                  : expired
                    ? "لایسنس منقضی شده"
                    : "فعال‌سازی لایسنس ویزیتو"}
            </h1>
            {suspended ? (
              <p className="text-xs text-muted-foreground leading-6">
                دسترسی این مجموعه به‌صورت موقت توسط پشتیبانی متوقف شده است. تمام اطلاعات شما محفوظ است؛
                برای رفع تعلیق با پشتیبانی تماس بگیرید.
              </p>
            ) : trialOver ? (
              <p className="text-xs text-muted-foreground leading-6">
                برای ادامه استفاده از ویزیتو، لایسنس تهیه کنید و کد آن را در کادر زیر وارد کنید.
                تمام اطلاعات شما (مشتریان، سفارش‌ها، پرداخت‌ها) محفوظ است و با فعال‌سازی لایسنس
                دقیقاً از همان‌جا ادامه می‌دهید.
              </p>
            ) : expired ? (
              <p className="text-xs text-muted-foreground leading-6">
                {state.name
                  ? `لایسنس ثبت‌شده برای «${state.name}» در تاریخ ${state.expiresAt ? formatJalali(state.expiresAt) : "—"} به پایان رسیده است.`
                  : state.expiresAt
                    ? `لایسنس در تاریخ ${formatJalali(state.expiresAt)} به پایان رسیده است.`
                    : "لایسنس فعال نیست."}{" "}
                برای ادامه کار، کلید لایسنس جدید (شارژ) را وارد کنید.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground leading-6">
                برای استفاده از ویزیتو، کلید لایسنس دریافتی از پشتیبانی را وارد کنید.
              </p>
            )}
          </div>

          {/* مهلت تمدید ۳۰ روزه پس از انقضای لایسنس مدت‌دار */}
          {expired && state.graceDaysLeft !== null && state.graceDaysLeft !== undefined && (
            <div className="rounded-xl border border-amber-300/60 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-950/40 p-3 space-y-1.5 text-right">
              <div className="flex items-center justify-between gap-2">
                <Badge className="text-[10px] gap-1 bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-0">
                  <Hourglass className="h-3 w-3" /> مهلت تمدید
                </Badge>
                <span className="text-[11px] font-bold text-amber-700 dark:text-amber-300">
                  {toFa(state.graceDaysLeft)} روز باقی‌مانده
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-5">
                در این مدت امکانات قفل است ولی تمام اطلاعات شما (مشتریان، سفارش‌ها، پرداخت‌ها) محفوظ است.
                با تمدید لایسنس همه‌چیز بدون تغییر فعال می‌شود.
              </p>
            </div>
          )}

          {/* دوره آزمایشی رایگان — پایان یافته (فاز TRIAL_OVER) یا در حال شمارش */}
          {(trialOver || (state.trial && trial)) && (
            <div className="rounded-xl border border-amber-300/60 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-950/40 p-3 space-y-1.5 text-right">
              <div className="flex items-center justify-between gap-2">
                <Badge className="text-[10px] gap-1 bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-0">
                  <Hourglass className="h-3 w-3" /> دوره آزمایشی رایگان
                </Badge>
                {trialOver || !trial || trial.over ? (
                  <span className="text-[11px] font-bold text-amber-700 dark:text-amber-300">پایان یافته</span>
                ) : (
                  <span className="text-[11px] font-bold text-amber-700 dark:text-amber-300" dir="rtl">
                    زمان باقی‌مانده: {toFa(trial.hours)} ساعت و {toFa(trial.minutes)} دقیقه
                  </span>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground leading-5">
                پس از پایان دوره آزمایشی باید لایسنس تهیه شود؛ اطلاعات شما محفوظ است.
              </p>
            </div>
          )}

          {/* اطمینان درباره داده‌ها — هیچ‌چیز حذف نمی‌شود */}
          <div className="rounded-xl border border-primary/20 bg-primary/[0.04] p-3 text-right space-y-1.5">
            <p className="text-[11px] font-bold text-primary flex items-center gap-1.5">
              <DatabaseBackup className="h-3.5 w-3.5" /> اطلاعات شما کاملاً محفوظ است
            </p>
            <p className="text-[11px] text-muted-foreground leading-5">
              با انقضای لایسنس هیچ مشتری، سفارش یا گزارشی حذف نمی‌شود. با شارژ مجدد، دقیقاً از همان‌جا ادامه می‌دهید.
            </p>
          </div>

          {state.activated && state.name && (
            <div className="text-[11px] text-muted-foreground flex items-center justify-center gap-1.5">
              <Clock3 className="h-3.5 w-3.5" />
              {state.org ? `مجموعه: ${state.org.name}` : `دارنده: ${state.name} ${state.mobile ? `— ${toFa(state.mobile)}` : ""}`}
            </div>
          )}

          {/* شناسه مجموعه — همراه درخواست خرید/تمدید/پشتیبانی خودکار شناسه را حمل می‌کند */}
          {state.org ? (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-secondary/40 p-2.5 text-right">
              <div className="min-w-0">
                <p className="text-[10px] text-muted-foreground">شناسه مجموعه — هنگام خرید/تمدید به فروشنده بفرستید</p>
                <p dir="ltr" className="text-xs font-mono font-bold text-foreground truncate">
                  {state.org.id}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0"
                onClick={() => {
                  void navigator.clipboard.writeText(state.org?.id || "");
                  toast({ title: "شناسه مجموعه کپی شد ✅" });
                }}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : state.installId && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-secondary/40 p-2.5 text-right">
              <div className="min-w-0">
                <p className="text-[10px] text-muted-foreground">شناسه نصب — هنگام خرید به فروشنده بفرستید</p>
                <p dir="ltr" className="text-xs font-mono font-bold text-foreground truncate">
                  {state.installId}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0"
                onClick={() => {
                  void navigator.clipboard.writeText(state.installId || "");
                  toast({ title: "شناسه نصب کپی شد ✅" });
                }}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}

          {/* تعرفه لایسنس — از سرور خوانده می‌شود */}
          <div className="rounded-xl border border-border bg-secondary/40 p-3 text-right space-y-2">
            <p className="text-xs font-bold text-primary flex items-center gap-1.5">
              <Tags className="h-3.5 w-3.5" /> تعرفه لایسنس
            </p>
            <div className="space-y-1.5">
              {pricing.durations.map((d) => (
                <div
                  key={d.key}
                  className="flex items-center justify-between gap-2 text-xs border-b border-dashed border-border/70 pb-1.5 last:border-0 last:pb-0"
                >
                  <span className="text-muted-foreground">{d.label}</span>
                  <span className="font-bold">{priceText(pricing.prices[d.key])}</span>
                </div>
              ))}
            </div>
          </div>

          {/* خرید از تلگرام پشتیبانی */}
          {pricing.telegram.trim() && (
            <Button variant="secondary" className="w-full" onClick={buyFromTelegram}>
              <Send className="h-4 w-4" />
              خرید لایسنس از پشتیبانی تلگرام
            </Button>
          )}

          {/* پشتیبانی داخلی — پیام درون‌برنامه‌ای (حتی در قفل باز است) + مسیرهای جایگزین */}
          <SupportSection
            hasOrg={!!state.org}
            defaultSubject={suspended ? "GENERAL" : trialOver || expired ? "RENEW" : "GENERAL"}
            phone={pricing.phone || ""}
          />

          <div className="space-y-2 text-right">
            <Label htmlFor="license-key" className="text-xs">
              کد لایسنس خود را وارد کنید
            </Label>
            <Input
              id="license-key"
              dir="ltr"
              placeholder="VZT3.xxxxxxxx.xxxxxxxx"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && activate()}
              className="font-mono text-[13px]"
              autoComplete="off"
            />
          </div>

          <Button className="w-full" size="lg" onClick={activate} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            فعال‌سازی لایسنس
          </Button>

          {!pricing.telegram.trim() && (
            <p className="text-[10px] text-muted-foreground leading-5">
              تهیه یا تمدید لایسنس: تماس با پشتیبانی فروشنده برنامه
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * بخش پشتیبانی صفحه قفل — الزام بخش ۲ و ۴ سند: در قفل/تعلیق «فقط پشتیبانی» باز است.
 * کاربر مجموعه‌دار می‌تواند همین‌جا پیام بفرستد (بدون تلگرام؛ فقط سرور ایرانی)؛
 * پیام مجموعه را سمت سرور خودکار حمل می‌کند و پاسخ پس از رفع قفل در «پشتیبانی» دیده می‌شود.
 * مسیرهای جایگزین (شماره تماس/تلگرام) هم نمایش داده می‌شود.
 */
const SUBJECT_ITEMS = [
  { key: "GENERAL", label: "عمومی / رفع تعلیق" },
  { key: "BUY_LICENSE", label: "خرید لایسنس" },
  { key: "RENEW", label: "تمدید لایسنس" },
];

function SupportSection({ hasOrg, defaultSubject, phone }: { hasOrg: boolean; defaultSubject: string; phone: string }) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState(defaultSubject);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [queued, setQueued] = useState(0);

  // شمارش صف انتظار + تخلیه خودکار با بازگشت اتصال
  useEffect(() => {
    if (!open) return;
    const refresh = () => void outboxList().then((items) => setQueued(items.length));
    refresh();
    const flush = async () => {
      const items = await outboxList();
      let createdThreadId = "";
      let didSend = false;
      for (const item of items) {
        try {
          if (item.threadId) {
            await fetch(`/api/support/threads/${item.threadId}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ body: item.body, clientRef: item.clientRef }),
            }).then((r) => {
              if (!r.ok && r.status !== 409) throw new Error("failed");
            });
          } else if (createdThreadId) {
            await fetch(`/api/support/threads/${createdThreadId}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ body: item.body, clientRef: item.clientRef }),
            }).then((r) => {
              if (!r.ok && r.status !== 409) throw new Error("failed");
            });
          } else {
            const res = await fetch("/api/support/threads", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ subjectType: item.subjectType, body: item.body, clientRef: item.clientRef }),
            });
            if (!res.ok && res.status !== 409) throw new Error("failed");
            const d = (await res.json().catch(() => null)) as { thread?: { id?: string } } | null;
            if (d?.thread?.id) createdThreadId = d.thread.id;
          }
          await outboxRemove(item.clientRef);
          didSend = true;
        } catch {
          break; // هنوز قطع است — تا ack سرور در صف می‌ماند
        }
      }
      if (didSend) refresh();
    };
    window.addEventListener("online", flush);
    refresh();
    return () => window.removeEventListener("online", flush);
  }, [open]);

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    if (!hasOrg) {
      toast({ title: "برای ارسال پیام وارد حساب شوید", description: "یا از مسیرهای جایگزین تماس استفاده کنید", variant: "destructive" });
      return;
    }
    setBusy(true);
    const clientRef = "crypto" in window && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-vzt`;
    await outboxEnqueue({ clientRef, threadId: "", subjectType: subject, body, createdAt: new Date().toISOString() });
    try {
      const res = await fetch("/api/support/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subjectType: subject, body, clientRef }),
      });
      if (!res.ok && res.status !== 409) throw new Error("failed");
      await outboxRemove(clientRef);
      setSent(true);
      setText("");
      toast({ title: "پیام شما ثبت شد ✅", description: "پاسخ پشتیبانی پس از ورود در بخش «پشتیبانی» نمایش داده می‌شود" });
    } catch {
      // در صف ماند — با بازگشت اینترنت خودکار ارسال می‌شود
      setQueued((q) => q + 1);
      setSent(true);
      setText("");
      toast({ title: "ذخیره شد", description: "اینترنت در دسترس نیست — پیام با بازگشت اتصال خودکار ارسال می‌شود" });
    } finally {
      setBusy(false);
      void outboxList().then((items) => setQueued(items.length));
    }
  };

  return (
    <div className="rounded-xl border border-border bg-secondary/40 p-3 text-right space-y-2">
      <button type="button" className="w-full flex items-center gap-1.5" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <LifeBuoy className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-bold text-primary flex-1 text-right">پشتیبانی درون‌برنامه‌ای</span>
        <span className="text-[10px] text-muted-foreground">{open ? "بستن" : "ارسال پیام"}</span>
      </button>

      {open && (
        <div className="space-y-2 pt-1">
          {!sent ? (
            <>
              <div className="flex gap-1.5 flex-wrap">
                {SUBJECT_ITEMS.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => setSubject(s.key)}
                    className={`rounded-full px-2.5 py-1 text-[10px] border transition-colors ${
                      subject === s.key
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-border text-muted-foreground hover:bg-accent/60"
                    }`}
                    aria-pressed={subject === s.key}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value.slice(0, 4000))}
                placeholder="درخواست خود را بنویسید — شناسه مجموعه شما خودکار پیوست می‌شود…"
                className="min-h-16 text-[12px] bg-background"
                aria-label="متن پیام پشتیبانی"
              />
              <Button size="sm" className="w-full gap-1.5" onClick={send} disabled={busy || !text.trim()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                ارسال به پشتیبانی
              </Button>
            </>
          ) : (
            <p className="text-[11px] text-emerald-700 dark:text-emerald-400 leading-5">
              پیام شما ثبت شد. پاسخ پس از رفع محدودیت، در بخش «پشتیبانی» برنامه نمایش داده می‌شود.
              {queued > 0 && ` (${toFa(queued)} پیام در انتظار ارسال)`}
            </p>
          )}
          {/* مسیرهای جایگزین — شماره تماس از تنظیمات سازنده */}
          {phone.trim() && (
            <Button
              size="sm"
              variant="outline"
              className="w-full h-8 text-[11px] gap-1.5"
              onClick={() => (window.location.href = `tel:${phone}`)}
            >
              <Phone className="h-3.5 w-3.5" />
              تماس تلفنی: <span dir="ltr">{toFa(phone)}</span>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
