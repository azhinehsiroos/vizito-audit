"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Check, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useApp } from "@/lib/store";
import { api } from "@/lib/api";
import { FA_MONTHS, formatJalali, formatMoney, jalaliOf, jalaliToIso, toEnDigits, toFa } from "@/lib/jalali";
import type { Order } from "@/lib/types";
import { toast } from "@/hooks/use-toast";
import { Banknote, Landmark, Loader2, Plus, ReceiptText, Wallet } from "lucide-react";

// ---------- انواع مشترک تسویه ----------

/** انواع تسویه: نقد / چک پای‌بار / رسید */
export const SETTLEMENT_TYPES = [
  { key: "CASH", label: "نقد" },
  { key: "CHECK", label: "چک پای بار" },
  { key: "RECEIPT", label: "رسید" },
] as const;

export function settlementLabel(key: string | null | undefined): string {
  return SETTLEMENT_TYPES.find((t) => t.key === key)?.label || "—";
}

/** سفارش + فیلدهای تسویه (تا به‌روزرسانی types.ts توسط سرپرست) */
export type OrderWithSettlement = Order & {
  settlementType?: string | null;
  dueDays?: number | null;
};

/** تاریخ سررسید = تاریخ فاکتور + تعداد روز */
export function dueDateOf(createdAt: string | Date | null | undefined, dueDays: number | null | undefined): Date | null {
  if (!createdAt || !dueDays || dueDays <= 0) return null;
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + dueDays * 86400000);
}

/** «سررسید: تسویه ۹۰ روزه — تا ۱۴۰۵/۱۱/۲۵» */
export function dueLine(dueDays: number | null | undefined, createdAt: string | null | undefined): string {
  const due = dueDateOf(createdAt, dueDays);
  if (!dueDays || !due) return "";
  return `سررسید: تسویه ${toFa(dueDays)} روزه — تا ${formatJalali(due)}`;
}

// ---------- فیلد تاریخ شمسی (سه سلکت — الگوی ReportsView) ----------

type JDate = { jy: number; jm: number; jd: number };

function JalaliDateField({ label, value, onChange }: { label: string; value: JDate; onChange: (v: JDate) => void }) {
  const today = jalaliOf(new Date());
  const years = useMemo(() => [today.jy - 1, today.jy, today.jy + 1, today.jy + 2], [today.jy]);
  return (
    <div className="space-y-1">
      <Label className="text-[11px]">{label}</Label>
      <div className="grid grid-cols-3 gap-1">
        <Select value={String(value.jd)} onValueChange={(d) => onChange({ ...value, jd: Number(d) })}>
          <SelectTrigger className="h-9 text-[11px] px-1.5">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-44">
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
              <SelectItem key={d} value={String(d)} className="text-[11px]">
                {toFa(d)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={String(value.jm)} onValueChange={(m) => onChange({ ...value, jm: Number(m) })}>
          <SelectTrigger className="h-9 text-[11px] px-1.5">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-44">
            {FA_MONTHS.map((m, i) => (
              <SelectItem key={m} value={String(i + 1)} className="text-[11px]">
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={String(value.jy)} onValueChange={(y) => onChange({ ...value, jy: Number(y) })}>
          <SelectTrigger className="h-9 text-[11px] px-1.5">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-44">
            {years.map((y) => (
              <SelectItem key={y} value={String(y)} className="text-[11px]">
                {toFa(y)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

// ---------- فرم وضعیت تسویه فاکتور (پایین فرم صدور فاکتور) ----------

export type InvoiceSettlementValue = { settlementType: string; dueDays: string };

/**
 * بخش «وضعیت تسویه فاکتور» در فرم صدور فاکتور:
 * انتخاب یکی از نقد / چک پای بار / رسید + سررسید به روز
 * (قابل استفاده در OrderForm — صادرشده برای سرپرست)
 */
export function InvoiceSettlementFields({
  value,
  onChange,
}: {
  value: InvoiceSettlementValue;
  onChange: (patch: Partial<InvoiceSettlementValue>) => void;
}) {
  return (
    <div className="rounded-xl border border-primary/30 bg-primary/[0.03] p-3 space-y-2.5">
      <Label className="text-xs font-bold flex items-center gap-1.5 text-primary">
        <Wallet className="h-3.5 w-3.5" /> وضعیت تسویه فاکتور
      </Label>
      <div className="flex gap-1.5">
        {SETTLEMENT_TYPES.map((t) => {
          const active = value.settlementType === t.key;
          return (
            <button
              key={t.key}
              type="button"
              aria-pressed={active}
              onClick={() => onChange({ settlementType: active ? "" : t.key })}
              className={`flex-1 flex items-center justify-center gap-1 rounded-lg border px-1 py-1.5 text-[11px] transition-colors ${
                active ? "border-primary bg-primary/10 text-primary font-bold" : "border-border text-muted-foreground hover:bg-accent/40"
              }`}
            >
              <span
                className={`h-3.5 w-3.5 shrink-0 rounded-[4px] border flex items-center justify-center ${
                  active ? "bg-primary border-primary text-primary-foreground" : "border-input bg-background"
                }`}
              >
                {active && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
              </span>
              {t.label}
            </button>
          );
        })}
      </div>
      <div className="space-y-1">
        <Label className="text-[11px]">سررسید تسویه (روز)</Label>
        <Input
          inputMode="numeric"
          className="h-8 text-xs"
          value={value.dueDays}
          onChange={(e) => {
            const n = Number(toEnDigits(e.target.value).replace(/\D/g, ""));
            onChange({ dueDays: e.target.value === "" ? "" : String(Math.min(3650, Math.max(0, n || 0))) });
          }}
          placeholder="مثلا: ۹۰ روزه"
        />
      </div>
    </div>
  );
}

// ---------- چک‌لیست تسویه (نمایش در فاکتور) ----------

/**
 * نمایش وضعیت تسویه در مشاهده فاکتور:
 * ☑ نقد / ☐ چک پای بار / ☐ رسید + خط سررسید
 */
export function SettlementChecklist({
  settlementType,
  dueDays,
  createdAt,
}: {
  settlementType?: string | null;
  dueDays?: number | null;
  createdAt?: string | null;
}) {
  const due = dueLine(dueDays, createdAt);
  return (
    <div className="space-y-2">
      <div className="text-xs font-bold flex items-center gap-1.5 text-primary">
        <Wallet className="h-3.5 w-3.5" /> وضعیت تسویه فاکتور
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {SETTLEMENT_TYPES.map((t) => {
          const active = settlementType === t.key;
          return (
            <div
              key={t.key}
              className={`flex items-center justify-center gap-1 rounded-lg border px-1 py-1.5 text-[10px] ${
                active ? "border-primary bg-primary/10 text-primary font-bold" : "border-dashed border-border text-muted-foreground/70"
              }`}
            >
              <span
                className={`h-3.5 w-3.5 shrink-0 rounded-[4px] border flex items-center justify-center ${
                  active ? "bg-primary border-primary text-primary-foreground" : "border-input bg-background"
                }`}
              >
                {active && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
              </span>
              {t.label}
            </div>
          );
        })}
      </div>
      {!settlementType && <p className="text-[10px] text-muted-foreground">نحوه تسویه روی این فاکتور ثبت نشده است</p>}
      {due && <p className="text-[11px] font-medium text-amber-700 dark:text-amber-400">{due}</p>}
    </div>
  );
}

// ---------- کارت تسویه حساب پروفایل مشتری ----------

export type PaymentRecord = {
  id: string;
  customerId: string;
  orderId: string | null;
  type: string;
  amount: number;
  /** تخفیف نقدی — فقط برای پرداخت نقدی (CASH) مقدار دارد */
  discountPercent: number;
  discountAmount: number;
  paidAt: string | null;
  trackingNumber: string | null;
  bankName: string | null;
  checkNumber: string | null;
  sayadiNumber: string | null;
  settleAt: string | null;
  note: string | null;
  createdByUserId: string | null;
  createdByUser?: { name: string } | null;
  createdAt: string;
};

type PaymentsResponse = {
  payments: PaymentRecord[];
  summary: { totalOrders: number; totalPaid: number; balance: number };
};

type PaymentType = "CASH" | "CHECK" | "RECEIPT";

const PAYMENT_TYPE_BADGES: Record<string, { label: string; cls: string; icon: React.ComponentType<{ className?: string }> }> = {
  CASH: { label: "نقد", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 border-0", icon: Banknote },
  CHECK: { label: "چک", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-0", icon: Landmark },
  RECEIPT: { label: "رسید", cls: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300 border-0", icon: ReceiptText },
};

const emptyForm = {
  type: "CASH" as PaymentType,
  amount: "",
  discountPercent: "", // تخفیف نقدی (درصد) — فقط نقدی
  trackingNumber: "",
  bankName: "",
  checkNumber: "",
  sayadiNumber: "",
  note: "",
};

/** خط تخفیف نقدی رکوردهای نقدی — در صورت داشتن درصد تخفیف */
function cashDiscountLine(p: PaymentRecord): string {
  if (p.type !== "CASH" || !p.discountPercent || p.discountPercent <= 0) return "";
  return `با ${toFa(p.discountPercent)}٪ تخفیف نقدی (${formatMoney(p.discountAmount || 0)} تومان تخفیف)`;
}

/** خط توضیح کوتاه هر رکورد تسویه */
function paymentDetailLine(p: PaymentRecord): string {
  if (p.type === "CASH") {
    const parts: string[] = [];
    if (p.paidAt) parts.push(`در تاریخ ${formatJalali(p.paidAt)} پرداخت شد`);
    if (p.trackingNumber) parts.push(`شماره پیگیری: ${toFa(p.trackingNumber)}`);
    return parts.join(" • ") || "نقدی";
  }
  if (p.type === "CHECK") {
    const parts = [p.bankName || "", p.checkNumber ? `چک ${toFa(p.checkNumber)}` : ""].filter(Boolean);
    if (p.sayadiNumber) parts.push(`صیادی: ${toFa(p.sayadiNumber)}`);
    if (p.settleAt) parts.push(`سررسید: ${formatJalali(p.settleAt)}`);
    return parts.join(" • ") || "—";
  }
  const parts: string[] = [];
  if (p.paidAt) parts.push(`در تاریخ ${formatJalali(p.paidAt)} تسویه شد`);
  if (p.note) parts.push(p.note);
  return parts.join(" • ") || "رسید";
}

export function SettlementSection({ customerId }: { customerId: string }) {
  const { me } = useApp();
  const [data, setData] = useState<PaymentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<PaymentRecord | null>(null);
  const [removing, setRemoving] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const today = jalaliOf(new Date());
  const [paidDate, setPaidDate] = useState<JDate>({ ...today });
  const [settleDate, setSettleDate] = useState<JDate>({ ...today });

  const load = useCallback(async () => {
    try {
      const res = await api<PaymentsResponse>(`/api/payments?customerId=${encodeURIComponent(customerId)}`);
      setData(res);
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
      setData({ payments: [], summary: { totalOrders: 0, totalPaid: 0, balance: 0 } });
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => {
    load();
  }, [load]);

  const openDialog = () => {
    // پیش‌پرکردن مبلغ با مانده حساب مشتری — تا کاربر مجبور به تایپ مجدد نباشد
    const bal = Math.round(data?.summary.balance ?? 0);
    setForm({ ...emptyForm, ...(bal > 0 ? { amount: String(bal) } : {}) });
    const t = jalaliOf(new Date());
    setPaidDate({ ...t });
    setSettleDate({ ...t });
    setDialogOpen(true);
  };

  const save = async () => {
    const total = Number(toEnDigits(form.amount).replace(/[^\d.]/g, ""));
    if (!total || total <= 0) {
      toast({ title: "خطا", description: "مبلغ تسویه را وارد کنید", variant: "destructive" });
      return;
    }
    if (form.type === "CHECK" && !form.bankName.trim()) {
      toast({ title: "خطا", description: "نام بانک را وارد کنید", variant: "destructive" });
      return;
    }
    // تخفیف نقدی: مبلغ ورودی = جمع بدهی مشتری؛ مبلغ ارسالی = نقد دریافتی
    const percent = form.type === "CASH" ? Math.min(99, Math.max(0, Number(toEnDigits(form.discountPercent).replace(/[^\d.]/g, "")) || 0)) : 0;
    const payable = Math.round(total * (1 - percent / 100));
    const discountAmount = Math.round((total * percent) / 100);
    if (form.type === "CASH" && payable <= 0 && percent < 100) {
      toast({ title: "خطا", description: "مبلغ پرداخت نقدی صفر شد — درصد را کاهش دهید", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await api("/api/payments", {
        method: "POST",
        body: {
          customerId,
          type: form.type,
          amount: form.type === "CASH" ? payable : total,
          // نقد و رسید: تاریخ پرداخت — چک: تاریخ سررسید/تسویه
          ...(form.type === "CHECK"
            ? { settleAt: jalaliToIso(settleDate.jy, settleDate.jm, settleDate.jd) }
            : { paidAt: jalaliToIso(paidDate.jy, paidDate.jm, paidDate.jd) }),
          ...(form.type === "CASH"
            ? { discountPercent: percent, discountAmount, ...(form.trackingNumber.trim() ? { trackingNumber: form.trackingNumber.trim() } : {}) }
            : {}),
          ...(form.type === "CHECK"
            ? {
                bankName: form.bankName.trim(),
                ...(form.checkNumber.trim() ? { checkNumber: form.checkNumber.trim() } : {}),
                ...(form.sayadiNumber.trim() ? { sayadiNumber: form.sayadiNumber.trim() } : {}),
              }
            : {}),
          ...(form.type === "RECEIPT" && form.note.trim() ? { note: form.note.trim() } : {}),
        },
      });
      toast({ title: "تسویه ثبت شد ✅", description: "حساب مشتری به‌روزرسانی شد" });
      setDialogOpen(false);
      load();
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setRemoving(true);
    try {
      await api(`/api/payments/${deleting.id}`, { method: "DELETE" });
      toast({ title: "تسویه حذف شد", description: "مانده حساب به‌روزرسانی شد" });
      setDeleting(null);
      load();
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setRemoving(false);
    }
  };

  const summary = data?.summary;
  const balance = summary?.balance ?? 0;
  const settled = balance <= 0;
  const payments = data?.payments || [];

  // خلاصه تخفیف نقدی برای نمایش زنده در دیالوگ
  const dialogTotal = Number(toEnDigits(form.amount).replace(/[^\d.]/g, "")) || 0;
  const dialogPercent =
    form.type === "CASH" ? Math.min(99, Math.max(0, Number(toEnDigits(form.discountPercent).replace(/[^\d.]/g, "")) || 0)) : 0;
  const dialogPayable = Math.round(dialogTotal * (1 - dialogPercent / 100));
  const dialogDiscountAmount = Math.round((dialogTotal * dialogPercent) / 100);

  return (
    <Card className="border-primary/20">
      <CardContent className="p-3 space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold flex items-center gap-1.5">
            <Wallet className="h-3.5 w-3.5 text-primary" /> تسویه حساب
          </span>
          <Button size="sm" className="h-7 text-[11px] px-2.5" onClick={openDialog}>
            <Plus className="h-3 w-3" /> ثبت تسویه
          </Button>
        </div>

        {loading ? (
          <div className="grid grid-cols-3 gap-2">
            <Skeleton className="h-12 rounded-lg" />
            <Skeleton className="h-12 rounded-lg" />
            <Skeleton className="h-12 rounded-lg" />
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-secondary/60 p-2">
              <div className="text-[9px] text-muted-foreground">جمع سفارش‌ها</div>
              <div className="text-[11px] font-black mt-0.5">{formatMoney(summary?.totalOrders ?? 0)}</div>
            </div>
            <div className="rounded-lg bg-secondary/60 p-2">
              <div className="text-[9px] text-muted-foreground">جمع پرداخت‌ها</div>
              <div className="text-[11px] font-black mt-0.5 text-emerald-700 dark:text-emerald-400">
                {formatMoney(summary?.totalPaid ?? 0)}
              </div>
            </div>
            <div className="rounded-lg bg-secondary/60 p-2">
              <div className="text-[9px] text-muted-foreground">مانده حساب</div>
              <div className={`text-[11px] font-black mt-0.5 ${settled ? "text-emerald-700 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                {formatMoney(balance)}
              </div>
              <div className={`text-[8.5px] mt-0.5 font-bold ${settled ? "text-emerald-700 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                {settled ? "تسویه شده ✅" : "طلب از مشتری"}
              </div>
            </div>
          </div>
        )}

        {!loading && payments.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[10px] text-muted-foreground font-bold">تاریخچه تسویه‌ها (جدیدترین)</div>
            {payments.map((p) => {
              const badge = PAYMENT_TYPE_BADGES[p.type] || PAYMENT_TYPE_BADGES.RECEIPT;
              const canDelete = !!me && (me.isAdmin || p.createdByUserId === me.id);
              return (
                <div key={p.id} className="rounded-lg bg-secondary/50 p-2">
                  <div className="flex items-center justify-between gap-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Badge variant="secondary" className={`text-[9px] gap-0.5 shrink-0 ${badge.cls}`}>
                        <badge.icon className="h-2.5 w-2.5" /> {badge.label}
                      </Badge>
                      <span className="text-[9.5px] text-muted-foreground truncate">{formatJalali(p.createdAt)}</span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <span className="font-black text-[11px]">{formatMoney(p.amount)}</span>
                      {canDelete && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 text-destructive"
                          aria-label="حذف تسویه"
                          onClick={() => setDeleting(p)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="text-[9.5px] text-muted-foreground mt-1">{paymentDetailLine(p)}</div>
                  {cashDiscountLine(p) && (
                    <div className="text-[9.5px] text-amber-700 dark:text-amber-400 mt-0.5 font-medium">{cashDiscountLine(p)}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {!loading && payments.length === 0 && (
          <p className="text-[10px] text-muted-foreground text-center">هنوز تسویه‌ای ثبت نشده است</p>
        )}
      </CardContent>

      {/* دیالوگ ثبت تسویه */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>ثبت تسویه حساب</DialogTitle>
            <DialogDescription>نوع تسویه را انتخاب و اطلاعات آن را وارد کنید</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {/* انتخاب نوع تسویه */}
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  { key: "CASH", label: "نقدی", icon: Banknote },
                  { key: "CHECK", label: "چک", icon: Landmark },
                  { key: "RECEIPT", label: "رسید", icon: ReceiptText },
                ] as const
              ).map((t) => {
                const active = form.type === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setForm((f) => ({ ...f, type: t.key }))}
                    className={`flex flex-col items-center gap-1 rounded-lg border p-2 text-[11px] transition-colors ${
                      active ? "border-primary bg-primary/10 text-primary font-bold" : "border-border text-muted-foreground hover:bg-accent/40"
                    }`}
                  >
                    <t.icon className="h-4 w-4" />
                    {t.label}
                  </button>
                );
              })}
            </div>

            {/* فیلدهای مشترک */}
            <div className="space-y-1">
              <Label>مبلغ (تومان) *</Label>
              <Input
                inputMode="numeric"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                placeholder="مثلا 5000000"
              />
            </div>

            {/* نقدی: تخفیف نقدی + خلاصه زنده + تاریخ پرداخت + شماره پیگیری */}
            {form.type === "CASH" && (
              <>
                <div className="space-y-1">
                  <Label>تخفیف نقدی (درصد)</Label>
                  <Input
                    inputMode="numeric"
                    value={form.discountPercent}
                    onChange={(e) => {
                      const n = Number(toEnDigits(e.target.value).replace(/[^\d.]/g, ""));
                      setForm({
                        ...form,
                        discountPercent: e.target.value === "" ? "" : String(Math.min(99, Math.max(0, n || 0))),
                      });
                    }}
                    placeholder="مثلا ۸ — حداکثر ۹۹"
                  />
                </div>
                {dialogTotal > 0 && dialogPercent > 0 && (
                  <div className="rounded-lg border border-primary/40 bg-primary/10 p-2.5 text-center space-y-0.5">
                    <div className="text-sm font-black text-primary">
                      مانده پرداخت نقدی: {formatMoney(dialogPayable)} تومان
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      مبلغ تخفیف: {formatMoney(dialogDiscountAmount)} تومان ({toFa(dialogPercent)}٪)
                    </div>
                  </div>
                )}
                <JalaliDateField label="تاریخ پرداخت" value={paidDate} onChange={setPaidDate} />
                <div className="space-y-1">
                  <Label>شماره پیگیری</Label>
                  <Input
                    inputMode="numeric"
                    value={form.trackingNumber}
                    onChange={(e) => setForm({ ...form, trackingNumber: e.target.value })}
                    placeholder="اختیاری"
                  />
                </div>
              </>
            )}

            {/* چک: بانک، شماره چک، صیادی، تاریخ تسویه */}
            {form.type === "CHECK" && (
              <>
                <div className="space-y-1">
                  <Label>نام بانک *</Label>
                  <Input
                    value={form.bankName}
                    onChange={(e) => setForm({ ...form, bankName: e.target.value })}
                    placeholder="مثلا ملی"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label>شماره چک</Label>
                    <Input
                      inputMode="numeric"
                      value={form.checkNumber}
                      onChange={(e) => setForm({ ...form, checkNumber: e.target.value })}
                      placeholder="اختیاری"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>شماره صیادی</Label>
                    <Input
                      inputMode="numeric"
                      value={form.sayadiNumber}
                      onChange={(e) => setForm({ ...form, sayadiNumber: e.target.value })}
                      placeholder="اختیاری"
                    />
                  </div>
                </div>
                <JalaliDateField label="تاریخ تسویه (سررسید)" value={settleDate} onChange={setSettleDate} />
              </>
            )}

            {/* رسید: تاریخ + توضیح */}
            {form.type === "RECEIPT" && (
              <>
                <JalaliDateField label="تاریخ" value={paidDate} onChange={setPaidDate} />
                <div className="space-y-1">
                  <Label>توضیح</Label>
                  <Textarea
                    rows={2}
                    value={form.note}
                    onChange={(e) => setForm({ ...form, note: e.target.value })}
                    placeholder="اختیاری — مثلا واریز به حساب شرکت"
                  />
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              انصراف
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} ثبت تسویه
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* تأیید حذف تسویه */}
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>حذف این تسویه؟</AlertDialogTitle>
            <AlertDialogDescription>
              این رکورد تسویه حذف می‌شود و مانده حساب مشتری دوباره محاسبه خواهد شد.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>انصراف</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} disabled={removing}>
              {removing && <Loader2 className="h-4 w-4 animate-spin" />} حذف
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
