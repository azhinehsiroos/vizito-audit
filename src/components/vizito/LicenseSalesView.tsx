"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useApp } from "@/lib/store";
import { api } from "@/lib/api";
import { formatJalali, formatMoney, toFa, toEnDigits } from "@/lib/jalali";
import type { LicenseSale, LicenseCharge } from "@/lib/types";
import { toast } from "@/hooks/use-toast";
import {
  Gem,
  ShieldCheck,
  Tags,
  Copy,
  RefreshCw,
  Loader2,
  Check,
  Plus,
  ArrowRight,
  ChevronLeft,
  BatteryCharging,
  Trash2,
  History,
  KeyRound,
  User,
  Phone,
  CalendarDays,
} from "lucide-react";

type DurationKey = "m1" | "m3" | "m6" | "y1";

/** نمایش قیمت آزاد: اگر عدد باشد با جداکننده هزارگان و تومان، وگرنه همان متن */
function salePriceText(raw: string | null): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const num = Number(toEnDigits(s).replace(/[,\s٬]/g, ""));
  if (Number.isFinite(num) && num > 0) return `${formatMoney(num)} تومان`;
  return toFa(s);
}

function daysLeftBadge(daysLeft: number) {
  if (daysLeft <= 0)
    return <Badge className="text-[9px] border-0 bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300">منقضی شده</Badge>;
  if (daysLeft <= 7)
    return <Badge className="text-[9px] border-0 bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300">{toFa(daysLeft)} روز مانده</Badge>;
  if (daysLeft <= 30)
    return <Badge className="text-[9px] border-0 bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">{toFa(daysLeft)} روز مانده</Badge>;
  return (
    <Badge className="text-[9px] border-0 bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
      {toFa(daysLeft)} روز مانده
    </Badge>
  );
}

/**
 * فروش لایسنس — فقط سازنده برنامه
 * ثبت خریدار → ورود مستقیم به پروفایل خریدار → شارژ مجدد (بدون کلید جدید) / حذف
 */
export function LicenseSalesView() {
  const { params } = useApp();
  const saleId = params.saleId;
  return saleId ? <SaleProfile saleId={saleId} /> : <SalesList />;
}

/* ------------------------------ لیست خریداران ------------------------------ */

function SalesList() {
  const { setView } = useApp();
  const [ownerUnlocked, setOwnerUnlocked] = useState(false);
  const [sales, setSales] = useState<LicenseSale[]>([]);
  const [loading, setLoading] = useState(true);

  // فرم ثبت فروش جدید
  const [formOpen, setFormOpen] = useState(false);
  const [buyerName, setBuyerName] = useState("");
  const [buyerMobile, setBuyerMobile] = useState("");
  const [durationKey, setDurationKey] = useState("30");
  const [customDays, setCustomDays] = useState("");
  const [price, setPrice] = useState("");
  const [note, setNote] = useState("");
  const [installId, setInstallId] = useState("");
  const [issuing, setIssuing] = useState(false);

  const loadSales = useCallback(async () => {
    try {
      const r = await api<{ sales: LicenseSale[] }>("/api/license/sales");
      setSales(r.sales ?? []);
    } catch {
      /* بی‌صدا */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // با توکن احراز هویت — تا وضعیت کامل (ownerUnlocked) برگردد
    api<{ ownerUnlocked?: boolean }>("/api/license/status")
      .then((d) => setOwnerUnlocked(!!d?.ownerUnlocked))
      .catch(() => {});
    void loadSales();
  }, [loadSales]);

  const resolveDays = () => {
    if (durationKey !== "custom") return Number(durationKey);
    const n = Number(toEnDigits(customDays).trim());
    return Number.isFinite(n) ? Math.round(n) : 0;
  };

  const registerSale = async () => {
    if (!buyerName.trim()) {
      toast({ title: "خطا", description: "نام خریدار را وارد کنید", variant: "destructive" });
      return;
    }
    if (!buyerMobile.trim()) {
      toast({ title: "خطا", description: "موبایل خریدار را وارد کنید", variant: "destructive" });
      return;
    }
    // امنیت: کلید بدون قفل نصب (installId) روی هر سروری کار می‌کند — صدور ممنوع
    if (!installId.trim()) {
      toast({
        title: "خطا",
        description: "شناسه نصب خریدار الزامی است — خریدار باید از تنظیمات برنامه خودش (کارت لایسنس) کپی و برایتان بفرستد",
        variant: "destructive",
      });
      return;
    }
    const days = resolveDays();
    if (days < 1 || days > 3650) {
      toast({ title: "خطا", description: "مدت لایسنس باید بین ۱ تا ۳۶۵۰ روز باشد", variant: "destructive" });
      return;
    }
    setIssuing(true);
    try {
      const res = await api<{ sale: LicenseSale }>("/api/license/sales", {
        method: "POST",
        body: {
          buyerName: buyerName.trim(),
          buyerMobile: buyerMobile.trim(),
          durationDays: days,
          ...(price.trim() ? { price: price.trim() } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
          installId: installId.trim(),
        },
      });
      toast({ title: "خریدار ثبت شد ✅", description: "به پروفایل خریدار رفتید — کلید را برایش بفرستید" });
      // ورود مستقیم به پروفایل خریدار
      setView("license-sales", { saleId: res.sale.id });
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setIssuing(false);
    }
  };

  return (
    <div className="space-y-3 app-fade">
      <div className="flex items-center justify-between">
        <h1 className="font-bold text-lg flex items-center gap-1.5">
          <Gem className="h-5 w-5 text-primary" /> فروش لایسنس
        </h1>
        {ownerUnlocked && (
          <Badge className="text-[9px] gap-1 bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border-0">
            <ShieldCheck className="h-2.5 w-2.5" /> دسترسی همیشگی سازنده ✅
          </Badge>
        )}
      </div>

      <PricingSettingsCard />

      {/* ثبت فروش جدید */}
      <Card className="border-primary/30">
        <CardContent className="p-3 space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-bold text-muted-foreground">ثبت خریدار جدید</div>
            <Button size="sm" variant="secondary" onClick={() => setFormOpen((v) => !v)}>
              <Plus className="h-4 w-4" /> ثبت فروش جدید
            </Button>
          </div>

          {formOpen && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-1.5">
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">نام خریدار *</Label>
                  <Input
                    value={buyerName}
                    onChange={(e) => setBuyerName(e.target.value)}
                    placeholder="نام / شرکت خریدار"
                    className="h-9 text-[12px]"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">موبایل خریدار *</Label>
                  <Input
                    dir="ltr"
                    inputMode="numeric"
                    value={buyerMobile}
                    onChange={(e) => setBuyerMobile(e.target.value)}
                    placeholder="09xxxxxxxxx"
                    className="h-9 text-[12px]"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">مدت لایسنس</Label>
                  <Select value={durationKey} onValueChange={setDurationKey}>
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="انتخاب مدت" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="30">۱ ماهه</SelectItem>
                      <SelectItem value="90">۳ ماهه</SelectItem>
                      <SelectItem value="180">۶ ماهه</SelectItem>
                      <SelectItem value="365">۱ ساله</SelectItem>
                      <SelectItem value="custom">سفارشی (روز)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">قیمت (اختیاری)</Label>
                  <Input
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    placeholder="مثلاً 2,500,000"
                    className="h-9 text-[12px]"
                  />
                </div>
              </div>
              {durationKey === "custom" && (
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">تعداد روز (۱ تا ۳۶۵۰)</Label>
                  <Input
                    inputMode="numeric"
                    value={customDays}
                    onChange={(e) => setCustomDays(e.target.value)}
                    placeholder="مثلاً 45"
                    className="h-9 text-[12px]"
                  />
                </div>
              )}
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">یادداشت (اختیاری)</Label>
                <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="اختیاری..." />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">شناسه نصب خریدار (الزامی — قفل کلید به نصب او)</Label>
                <Input
                  dir="ltr"
                  value={installId}
                  onChange={(e) => setInstallId(e.target.value)}
                  placeholder="ab12cd34... خریدار از تنظیمات برنامه خودش می‌فرستد"
                  className="h-9 text-[12px] font-mono"
                />
                <p className="text-[9px] text-muted-foreground leading-4">
                  هر نصب ویزیتو یک «شناسه نصب» یکتا دارد (در تنظیمات → کارت لایسنس همان نصب دیده می‌شود). خریدار این
                  شناسه را برای شما می‌فرستد؛ کلید صادرشده فقط روی نصب او کار می‌کند و روی هر سرور دیگری باطل است — به
                  این ترتیب یک کلید را نمی‌شود بین چند نفر به اشتراک گذاشت.
                </p>
              </div>
              <Button size="sm" className="w-full" onClick={registerSale} disabled={issuing}>
                {issuing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                ثبت خریدار و ورود به پروفایل
              </Button>
              <p className="text-[10px] text-muted-foreground leading-4">
                پس از ثبت، مستقیم وارد پروفایل خریدار می‌شوید؛ کلید لایسنس آن‌جا قابل کپی است و شارژ مجدد بعدی هم
                بدون کلید جدید از همان‌جا انجام می‌شود.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* دفتر خریداران */}
      <div className="space-y-2">
        <div className="text-[11px] font-bold text-muted-foreground">دفتر خریداران لایسنس</div>
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
          </div>
        ) : sales.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-center space-y-1.5">
              <Gem className="h-8 w-8 text-muted-foreground/40 mx-auto" />
              <p className="text-xs text-muted-foreground">هنوز لایسنسی نفروخته شده — اولین خریدار را ثبت کنید</p>
            </CardContent>
          </Card>
        ) : (
          sales.map((s) => (
            <Card
              key={s.id}
              className="hover:border-primary/40 transition-colors cursor-pointer"
              onClick={() => setView("license-sales", { saleId: s.id })}
            >
              <CardContent className="p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-bold text-sm flex items-center gap-1">
                        <User className="h-3.5 w-3.5 text-primary" /> {s.buyerName}
                      </span>
                      <Badge variant="secondary" className="text-[9px]">
                        {s.durationLabel}
                      </Badge>
                      {daysLeftBadge(s.daysLeft)}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
                      <span dir="ltr" className="flex items-center gap-1">
                        <Phone className="h-3 w-3" /> {toFa(s.buyerMobile)}
                      </span>
                      <span className="flex items-center gap-1">
                        <CalendarDays className="h-3 w-3" /> صدور: {formatJalali(s.createdAt)}
                      </span>
                    </div>
                  </div>
                  <ChevronLeft className="h-4 w-4 text-muted-foreground shrink-0" />
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}

/* ------------------------------ پروفایل خریدار ------------------------------ */

function SaleProfile({ saleId }: { saleId: string }) {
  const { setView } = useApp();
  const [sale, setSale] = useState<LicenseSale | null>(null);
  const [loading, setLoading] = useState(true);

  // شارژ مجدد
  const [rechargeOpen, setRechargeOpen] = useState(false);
  const [chargeKey, setChargeKey] = useState("30");
  const [chargeCustom, setChargeCustom] = useState("");
  const [chargeNote, setChargeNote] = useState("");
  const [charging, setCharging] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ sale: LicenseSale }>(`/api/license/sales/${saleId}`);
      setSale(r.sale);
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
      setView("license-sales");
    } finally {
      setLoading(false);
    }
  }, [saleId, setView]);

  useEffect(() => {
    void load();
  }, [load]);

  const copyKey = async (k: string) => {
    try {
      await navigator.clipboard.writeText(k);
      toast({ title: "کپی شد ✅", description: "کلید لایسنس در حافظه کپی شد" });
    } catch {
      toast({ title: "کلید لایسنس", description: k });
    }
  };

  const resolveChargeDays = () => {
    if (chargeKey !== "custom") return Number(chargeKey);
    const n = Number(toEnDigits(chargeCustom).trim());
    return Number.isFinite(n) ? Math.round(n) : 0;
  };

  const recharge = async () => {
    const days = resolveChargeDays();
    if (days < 1 || days > 3650) {
      toast({ title: "خطا", description: "مدت شارژ باید بین ۱ تا ۳۶۵۰ روز باشد", variant: "destructive" });
      return;
    }
    setCharging(true);
    try {
      const res = await api<{ sale: LicenseSale }>(`/api/license/sales/${saleId}`, {
        method: "PATCH",
        body: { addDays: days, ...(chargeNote.trim() ? { note: chargeNote.trim() } : {}) },
      });
      setSale((prev) => (prev ? { ...res.sale, charges: prev.charges } : res.sale));
      setRechargeOpen(false);
      setChargeKey("30");
      setChargeCustom("");
      setChargeNote("");
      toast({ title: "لایسنس شارژ شد ✅", description: "همان کلید قبلی معتبر می‌ماند — تمدید خودکار اعمال شد" });
      void load();
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setCharging(false);
    }
  };

  const removeSale = async () => {
    if (!sale) return;
    if (!confirm(`فروش لایسنس «${sale.buyerName}» حذف شود؟\nاگر این کلید فعال شده باشد، برنامه خریدار قفل می‌شود.`)) return;
    try {
      await api(`/api/license/sales/${saleId}`, { method: "DELETE" });
      toast({ title: "حذف شد", description: "فروش لایسنس از دفتر حذف شد" });
      setView("license-sales");
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    }
  };

  if (loading || !sale) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const charges: LicenseCharge[] = sale.charges ?? [];

  return (
    <div className="space-y-3 app-fade">
      <div className="flex items-center justify-between">
        <h1 className="font-bold text-lg">پروفایل خریدار لایسنس</h1>
        <Button size="sm" variant="ghost" onClick={() => setView("license-sales")}>
          <ArrowRight className="h-4 w-4" /> بازگشت
        </Button>
      </div>

      {/* مشخصات خریدار */}
      <Card className="border-primary/30">
        <CardContent className="p-3 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="font-bold text-sm flex items-center gap-1.5">
              <User className="h-4 w-4 text-primary" /> {sale.buyerName}
            </span>
            <div className="flex items-center gap-1.5">
              <Badge variant="secondary" className="text-[9px]">
                {sale.durationLabel}
              </Badge>
              {daysLeftBadge(sale.daysLeft)}
            </div>
          </div>
          <Separator />
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
            <div className="flex items-center justify-between gap-2 col-span-2 sm:col-span-1">
              <span className="text-muted-foreground text-[10px]">موبایل</span>
              <span dir="ltr" className="font-bold">{toFa(sale.buyerMobile)}</span>
            </div>
            <div className="flex items-center justify-between gap-2 col-span-2 sm:col-span-1">
              <span className="text-muted-foreground text-[10px]">قیمت فروش</span>
              <span className="font-bold">{salePriceText(sale.price) || "—"}</span>
            </div>
            <div className="flex items-center justify-between gap-2 col-span-2 sm:col-span-1">
              <span className="text-muted-foreground text-[10px]">تاریخ صدور</span>
              <span>{formatJalali(sale.createdAt)}</span>
            </div>
            <div className="flex items-center justify-between gap-2 col-span-2 sm:col-span-1">
              <span className="text-muted-foreground text-[10px]">انقضای لایسنس</span>
              <span className="font-bold text-primary">{formatJalali(sale.expiresAt)}</span>
            </div>
          </div>

          {/* کلید لایسنس */}
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground flex items-center gap-1">
              <KeyRound className="h-3 w-3" /> کلید لایسنس خریدار
            </Label>
            <div className="flex items-center gap-1.5">
              <div
                dir="ltr"
                className="flex-1 min-h-9 rounded-lg bg-secondary/60 border border-border px-2 py-1.5 font-mono text-[10px] break-all select-all"
              >
                {sale.key}
              </div>
              <Button size="icon" variant="secondary" className="h-9 w-9 shrink-0" onClick={() => copyKey(sale.key)} aria-label="کپی کلید">
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground leading-4">
              کلید را برای خریدار بفرستید تا در صفحه لایسنس برنامه وارد کند. با شارژ مجدد، همین کلید معتبر می‌ماند.
            </p>
          </div>

          {sale.note && <p className="text-[11px] text-muted-foreground">یادداشت: {sale.note}</p>}

          {/* اکشن‌ها */}
          <div className="flex gap-1.5 pt-1">
            <Button size="sm" className="flex-1" onClick={() => setRechargeOpen((v) => !v)}>
              <BatteryCharging className="h-4 w-4" /> شارژ مجدد
            </Button>
            <Button size="sm" variant="ghost" className="text-destructive" onClick={removeSale} aria-label="حذف فروش">
              <Trash2 className="h-4 w-4" /> حذف
            </Button>
          </div>

          {/* فرم شارژ مجدد — همان کلید، فقط تمدید */}
          {rechargeOpen && (
            <div className="rounded-xl border border-primary/30 bg-primary/5 p-2.5 space-y-2">
              <div className="text-[11px] font-bold">شارژ / تمدید لایسنس (بدون کلید جدید)</div>
              <div className="grid grid-cols-2 gap-1.5">
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">مدت شارژ</Label>
                  <Select value={chargeKey} onValueChange={setChargeKey}>
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="انتخاب مدت" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="30">۱ ماهه</SelectItem>
                      <SelectItem value="90">۳ ماهه</SelectItem>
                      <SelectItem value="180">۶ ماهه</SelectItem>
                      <SelectItem value="365">۱ ساله</SelectItem>
                      <SelectItem value="custom">سفارشی (روز)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {chargeKey === "custom" && (
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">تعداد روز</Label>
                    <Input
                      inputMode="numeric"
                      value={chargeCustom}
                      onChange={(e) => setChargeCustom(e.target.value)}
                      placeholder="مثلاً 15"
                      className="h-9 text-[12px]"
                    />
                  </div>
                )}
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">یادداشت شارژ (اختیاری)</Label>
                <Input value={chargeNote} onChange={(e) => setChargeNote(e.target.value)} placeholder="مثلاً پرداخت واریزی ۵۰۰ هزار" className="h-9 text-[12px]" />
              </div>
              <div className="flex gap-1.5">
                <Button size="sm" onClick={recharge} disabled={charging}>
                  {charging ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  تمدید لایسنس
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRechargeOpen(false)} disabled={charging}>
                  انصراف
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* تاریخچه شارژ */}
      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="text-xs font-bold flex items-center gap-1.5">
            <History className="h-3.5 w-3.5 text-primary" /> تاریخچه شارژ / تمدید
          </div>
          {charges.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">هنوز شارژی ثبت نشده — مدت اولیه با صدور لایسنس فعال شده است</p>
          ) : (
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {charges.map((c) => (
                <div key={c.id} className="rounded-lg bg-secondary/50 p-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[11px] font-bold">شارژ {toFa(c.addDays)} روزه</div>
                    <div className="text-[10px] text-muted-foreground">
                      {formatJalali(c.createdAt)}
                      {c.createdByName ? ` • توسط ${c.createdByName}` : ""}
                      {c.note ? ` • ${c.note}` : ""}
                    </div>
                  </div>
                  <Badge variant="secondary" className="text-[9px] shrink-0">+{toFa(c.addDays)} روز</Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ---------------------- تنظیم قیمت‌ها و تلگرام پشتیبانی ---------------------- */

function PricingSettingsCard() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prices, setPrices] = useState<Record<DurationKey, string>>({ m1: "", m3: "", m6: "", y1: "" });
  const [telegram, setTelegram] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);

  useEffect(() => {
    fetch("/api/license/pricing", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (d && d.prices) setPrices({ m1: d.prices.m1 ?? "", m3: d.prices.m3 ?? "", m6: d.prices.m6 ?? "", y1: d.prices.y1 ?? "" });
        if (d && typeof d.telegram === "string") setTelegram(d.telegram);
      })
      .catch(() => {});
  }, []);

  const saveSettings = async () => {
    setSavingSettings(true);
    try {
      const res = await api<{ ok: boolean; prices: Record<DurationKey, string>; telegram: string }>("/api/license/settings", {
        method: "PUT",
        body: {
          prices: { m1: prices.m1.trim(), m3: prices.m3.trim(), m6: prices.m6.trim(), y1: prices.y1.trim() },
          telegram: telegram.trim().replace(/^@/, ""),
        },
      });
      setPrices(res.prices);
      setTelegram(res.telegram);
      toast({ title: "تنظیمات فروش ذخیره شد ✅", description: "تعرفه‌ها در صفحه قفل لایسنس نمایش داده می‌شود" });
      setSettingsOpen(false);
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <Button size="sm" variant="secondary" className="w-full" onClick={() => setSettingsOpen((v) => !v)}>
          <Tags className="h-4 w-4" />
          تنظیم قیمت‌ها و تلگرام پشتیبانی
        </Button>

        {settingsOpen && (
          <div className="rounded-xl border border-border bg-secondary/40 p-2.5 space-y-2">
            <div className="text-[11px] font-bold text-muted-foreground">تعرفه‌های صفحه قفل لایسنس</div>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">۱ ماهه</Label>
                <Input
                  inputMode="numeric"
                  value={prices.m1}
                  onChange={(e) => setPrices({ ...prices, m1: e.target.value })}
                  placeholder="مثلاً 250000"
                  className="h-9 text-[12px]"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">۳ ماهه</Label>
                <Input
                  inputMode="numeric"
                  value={prices.m3}
                  onChange={(e) => setPrices({ ...prices, m3: e.target.value })}
                  placeholder="مثلاً 600000"
                  className="h-9 text-[12px]"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">۶ ماهه</Label>
                <Input
                  inputMode="numeric"
                  value={prices.m6}
                  onChange={(e) => setPrices({ ...prices, m6: e.target.value })}
                  placeholder="مثلاً 1000000"
                  className="h-9 text-[12px]"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">۱ ساله</Label>
                <Input
                  inputMode="numeric"
                  value={prices.y1}
                  onChange={(e) => setPrices({ ...prices, y1: e.target.value })}
                  placeholder="مثلاً 1800000"
                  className="h-9 text-[12px]"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="support-telegram" className="text-[10px] text-muted-foreground">
                آیدی تلگرام پشتیبانی (بدون @)
              </Label>
              <Input
                id="support-telegram"
                dir="ltr"
                value={telegram}
                onChange={(e) => setTelegram(e.target.value)}
                placeholder="vizito_support"
                className="h-9 text-[12px]"
              />
            </div>
            <div className="flex gap-1.5">
              <Button size="sm" onClick={saveSettings} disabled={savingSettings}>
                {savingSettings ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                ذخیره
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSettingsOpen(false)} disabled={savingSettings}>
                بستن
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground leading-4">
              قیمت خالی یعنی «تماس بگیرید» نمایش داده می‌شود؛ آیدی تلگرام خالی یعنی دکمه خرید مخفی می‌شود.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
