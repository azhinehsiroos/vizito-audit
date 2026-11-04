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
  /** فاز قفل (TRIAL_OVER / LICENSE_EXPIRED / NOT_ACTIVATED) — برای پیام درست «پایان مهلت رایگان» */
  phase?: string | null;
  /** نصب تازه (هیچ حسابی نیست) — به‌جای این صفحه، صفحه ورود/ثبت‌نام مدیر اول نشان داده می‌شود */
  freshInstall?: boolean;
};

type DurationKey = "m1" | "m3" | "m6" | "y1" | "perm";

type Pricing = {
  prices: Record<DurationKey, string>;
  telegram: string;
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
              {trialOver
                ? "مهلت استفاده رایگان شما به پایان رسیده است"
                : expired
                  ? "لایسنس منقضی شده"
                  : "فعال‌سازی لایسنس ویزیتو"}
            </h1>
            {trialOver ? (
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
              دارنده: {state.name} {state.mobile ? `— ${toFa(state.mobile)}` : ""}
            </div>
          )}

          {state.installId && (
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

          <div className="space-y-2 text-right">
            <Label htmlFor="license-key" className="text-xs">
              کد لایسنس خود را وارد کنید
            </Label>
            <Input
              id="license-key"
              dir="ltr"
              placeholder="VZT2.xxxxxxxx.xxxxxxxx"
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
