"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import Image from "next/image";
import { PdfExportButtons, OffscreenDoc } from "@/components/vizito/PdfExport";
import { PdfBrandHeader, PdfFooter, GOLD, GOLD_SOFT, LINE } from "@/components/vizito/PdfDocs";
import { InvoiceSettlementFields, SettlementSection, type InvoiceSettlementValue } from "@/components/vizito/SettlementSection";
import { useApp } from "@/lib/store";
import { api } from "@/lib/api";
import { formatJalaliDateTime, formatMoney, toEnDigits, toFa } from "@/lib/jalali";
import { visiblePriceTypes, priceOfProduct, priceTypeLabel, CUSTOMER_TYPES } from "@/lib/sections";
import type { Customer, Order, ProductGroup } from "@/lib/types";
import { orderOutboxAdd, orderOutboxList } from "@/lib/idb";
import { getDeviceId, newClientRef, readSnapshot, mirror } from "@/lib/offline";
import { toast } from "@/hooks/use-toast";
import {
  User,
  Building2,
  Phone,
  MapPin,
  IdCard,
  ChevronRight,
  Gift,
  Package,
  ShoppingCart,
  Percent,
  Trash2,
  Loader2,
  ClipboardList,
  FileText,
  Archive,
} from "lucide-react";

type Selected = { productId: string; quantity: number; offer: string };

export function CustomerProfile() {
  const { params, setView, can, setInvoiceDraft, online, setPendingOrders } = useApp();
  const canPurchase = can("purchase_price");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Record<string, Selected>>({});
  const [priceType, setPriceType] = useState("STORE");
  const [saving, setSaving] = useState(false);
  // نحوه تسویه فاکتور (نقد/چک/رسید) + سررسید به روز — از فرم سفارش سریع پروفایل ارسال می‌شود
  const [settlement, setSettlement] = useState<InvoiceSettlementValue>({ settlementType: "", dueDays: "" });
  const patchSettlement = (patch: Partial<InvoiceSettlementValue>) => setSettlement((prev) => ({ ...prev, ...patch }));

  const load = useCallback(async () => {
    try {
      const [c, g] = await Promise.all([
        api<Customer>(`/api/customers/${params.customerId}`),
        api<ProductGroup[]>("/api/groups"),
      ]);
      setCustomer(c);
      setGroups(g);
      setPriceType(defaultTypeFor(c.type));
      void mirror("groups", g);
    } catch {
      // قطعی — اسنپ‌شات (مشتری از فهرست آخرین همگام‌سازی)
      const [cs, gs] = await Promise.all([
        readSnapshot<Customer[]>("customers"),
        readSnapshot<ProductGroup[]>("groups"),
      ]);
      const c = cs?.value.find((x) => x.id === params.customerId) || null;
      if (c) {
        setCustomer(c);
        setPriceType(defaultTypeFor(c.type));
      }
      if (gs) setGroups(gs.value);
      if (!c) {
        toast({
          title: "حالت آفلاین",
          description: "این مشتری در اسنپ‌شات دستگاه نیست — پس از اتصال دوباره تلاش کنید",
          variant: "destructive",
        });
      }
    } finally {
      setLoading(false);
    }
  }, [params.customerId]);

  useEffect(() => {
    load();
  }, [load]);

  const selectedList = useMemo(() => Object.values(selected), [selected]);

  const findProduct = useCallback(
    (id: string) => {
      for (const g of groups) {
        const p = g.products.find((x) => x.id === id);
        if (p) return p;
      }
      return null;
    },
    [groups]
  );

  const lineTotal = (s: Selected) => {
    const p = findProduct(s.productId);
    if (!p) return 0;
    return Math.max(0, Math.round(s.quantity * priceOfProduct(p, priceType) * (1 - p.discount / 100)));
  };
  const total = selectedList.reduce((sum, s) => sum + lineTotal(s), 0);

  const toggleProduct = (productId: string, checked: boolean) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (checked) next[productId] = { productId, quantity: 1, offer: "" };
      else delete next[productId];
      return next;
    });
  };
  const patchSelected = (productId: string, patch: Partial<Selected>) => {
    setSelected((prev) => ({ ...prev, [productId]: { ...prev[productId], ...patch } }));
  };

  /** صدور فاکتور فروش از خود پروفایل — مشتری ثابت + کالاهای انتخاب‌شده منتقل می‌شود */
  const openInvoice = () => {
    if (!customer) return;
    setInvoiceDraft({
      customerId: customer.id,
      selections: Object.fromEntries(
        selectedList.map((s) => [s.productId, { quantity: s.quantity, offer: s.offer }])
      ),
    });
    setView("order-form", { customerId: customer.id, from: "profile" });
  };

  const submitOrder = async () => {
    if (selectedList.length === 0) {
      toast({ title: "خطا", description: "ابتدا کالا انتخاب کنید", variant: "destructive" });
      return;
    }
    // ── ثبت آفلاین از پروفایل (بخش ۵.۳ سند) — همان مسیر OrderForm ──
    if (!online) {
      const clientRef = newClientRef();
      const rows = selectedList.map((s, idx) => {
        const p = findProduct(s.productId)!;
        const lt = Math.max(0, Math.round(s.quantity * priceOfProduct(p, priceType) * (1 - p.discount / 100)));
        return {
          productId: s.productId,
          productName: p.name,
          quantity: s.quantity,
          volume: p.volume || null,
          price: priceOfProduct(p, priceType),
          discount: p.discount,
          offer: s.offer || null,
          lineTotal: lt,
          rowNumber: idx + 1,
        };
      });
      setSaving(true);
      try {
        await orderOutboxAdd({
          clientRef,
          deviceId: getDeviceId(),
          customerId: customer!.id,
          customerName: customer!.name,
          title: `سفارش پروفایل ${customer!.name}`,
          priceType,
          note: null,
          settlementType: settlement.settlementType || null,
          dueDays: (() => {
            const n = Number(toEnDigits(settlement.dueDays).replace(/\D/g, ""));
            return n > 0 ? Math.min(3650, Math.round(n)) : null;
          })(),
          totalAmount: rows.reduce((s2, r) => s2 + r.lineTotal, 0),
          items: rows,
          createdAt: new Date().toISOString(),
          syncedAt: null,
        });
        setPendingOrders((await orderOutboxList()).length);
        toast({
          title: "سفارش در حالت آفلاین ثبت شد ✅",
          description: "پس از بازگشت اتصال خودکار برای سرور ارسال می‌شود",
        });
        setSelected({});
        setSettlement({ settlementType: "", dueDays: "" });
      } catch {
        toast({ title: "خطا", description: "ذخیره محلی سفارش ناموفق بود", variant: "destructive" });
      } finally {
        setSaving(false);
      }
      return;
    }
    setSaving(true);
    try {
      const order = await api<Order>("/api/orders", {
        method: "POST",
        body: {
          customerId: customer!.id,
          priceType,
          title: `سفارش پروفایل ${customer!.name}`,
          items: selectedList.map((s) => {
            const p = findProduct(s.productId)!;
            return {
              productId: s.productId,
              productName: p.name,
              quantity: s.quantity,
              volume: p.volume || "",
              price: priceOfProduct(p, priceType),
              discount: p.discount,
              offer: s.offer,
            };
          }),
          // وضعیت تسویه فاکتور (اختیاری) — نقد/چک پای بار/رسید + سررسید به روز
          settlementType: settlement.settlementType || null,
          dueDays: (() => {
            const n = Number(toEnDigits(settlement.dueDays).replace(/\D/g, ""));
            return n > 0 ? Math.min(3650, Math.round(n)) : null;
          })(),
        },
      });
      toast({ title: "سفارش ثبت شد ✅", description: "سفارش در پروفایل مشتری ذخیره شد" });
      setSelected({});
      setSettlement({ settlementType: "", dueDays: "" });
      load();
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const removeOrder = async (o: Order) => {
    if (!confirm("این سفارش حذف شود؟")) return;
    try {
      await api(`/api/orders/${o.id}`, { method: "DELETE" });
      toast({ title: "حذف شد" });
      load();
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    }
  };

  if (loading || !customer) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const orders = customer.orders || [];

  return (
    <div className="space-y-3 app-fade">
      <div className="flex items-center justify-between">
        <Button size="sm" variant="ghost" onClick={() => setView("customers")}>
          <ChevronRight className="h-4 w-4" /> مشتریان
        </Button>
        <h1 className="font-bold text-base">پروفایل مشتری</h1>
      </div>

      {/* صدور فاکتور فروش مستقیم از پروفایل — بدون نیاز به رفتن به سفارشات */}
      <Button className="w-full" size="lg" onClick={openInvoice}>
        <FileText className="h-4 w-4" /> صدور فاکتور فروش برای {customer.name}
      </Button>

      {/* شناسنامه */}
      <Card className="border-primary/20">
        <CardContent className="p-3 space-y-1.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-bold text-sm flex items-center gap-1.5">
              <User className="h-4 w-4 text-primary" /> {customer.name}
            </span>
            <span className="flex items-center gap-1">
              {customer.archived && (
                <Badge variant="outline" className="text-[9px] gap-1 text-muted-foreground">
                  <Archive className="h-3 w-3" /> آرشیو شده — سوابق حفظ شده است
                </Badge>
              )}
              <Badge variant="secondary" className="text-[9px]">
                {CUSTOMER_TYPES.find((t) => t.key === customer.type)?.label || customer.type}
              </Badge>
            </span>
          </div>
          {customer.company && (
            <div className="text-muted-foreground flex items-center gap-1">
              <Building2 className="h-3 w-3" /> {customer.company}
            </div>
          )}
          <div className="text-muted-foreground flex items-center gap-1" dir="ltr">
            <Phone className="h-3 w-3" /> {toFa(customer.phone)}
          </div>
          {customer.address && (
            <div className="text-muted-foreground flex items-center gap-1">
              <MapPin className="h-3 w-3" /> {customer.address}
            </div>
          )}
          {customer.nationalId && (
            <div className="text-muted-foreground flex items-center gap-1">
              <IdCard className="h-3 w-3" /> کد ملی: {toFa(customer.nationalId)}
            </div>
          )}
          <Separator className="my-1.5" />
          <div className="flex justify-between">
            <span className="text-muted-foreground">تعداد سفارش‌ها</span>
            <span className="font-bold">{toFa(orders.length)}</span>
          </div>
          <PdfExportButtons
            docId="customer-profile-doc"
            filename={`vizito-customer-${customer.name}.pdf`}
            layout="grid"
          />
        </CardContent>
      </Card>

      {/* تسویه حساب مشتری — مانده حساب و ثبت پرداخت نقد/چک/رسید */}
      <SettlementSection customerId={customer.id} />

      {/* انتخاب کالا از گروه‌ها */}
      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-bold flex items-center gap-1.5">
              <ShoppingCart className="h-3.5 w-3.5 text-primary" /> سفارش از گروه‌های کالا
            </Label>
            <Select value={priceType} onValueChange={setPriceType}>
              <SelectTrigger className="h-8 w-36 text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {visiblePriceTypes(canPurchase).map((t) => (
                  <SelectItem key={t.key} value={t.key}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {groups.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-3">هنوز گروه/کالایی ثبت نشده است</p>
          ) : (
            <Accordion type="multiple">
              {groups.map((g) => (
                <AccordionItem key={g.id} value={g.id}>
                  <AccordionTrigger className="text-xs py-2.5 hover:no-underline">
                    <span className="flex items-center gap-1.5 font-bold">
                      <Package className="h-3.5 w-3.5 text-primary" /> {g.name}
                      <Badge variant="secondary" className="text-[9px]">
                        {toFa(g.products.length)}
                      </Badge>
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-2 pb-2">
                    {g.products.length === 0 && (
                      <p className="text-[11px] text-muted-foreground text-center py-2">کالایی در این گروه نیست</p>
                    )}
                    {g.products.map((p) => {
                      const sel = selected[p.id];
                      return (
                        <div
                          key={p.id}
                          className={`rounded-lg border p-2 transition-colors ${
                            sel ? "border-primary/50 bg-primary/5" : "border-border"
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <Checkbox
                              checked={!!sel}
                              onCheckedChange={(v) => toggleProduct(p.id, !!v)}
                              aria-label={`انتخاب ${p.name}`}
                            />
                            <div className="w-9 h-9 rounded-md bg-secondary/70 overflow-hidden shrink-0 flex items-center justify-center">
                              {p.image ? (
                                <Image src={p.image} alt={p.name} width={36} height={36} className="object-cover w-full h-full" unoptimized />
                              ) : (
                                <Package className="h-4 w-4 text-muted-foreground/50" />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-[11px] font-bold truncate">{p.name}</div>
                              <div className="text-[10px] text-muted-foreground">
                                {priceTypeLabel(priceType)}: {formatMoney(priceOfProduct(p, priceType))}
                                {p.discount > 0 && ` • ${toFa(p.discount)}٪ تخفیف`}
                              </div>
                            </div>
                            {p.offer && (
                              <Badge variant="secondary" className="text-[9px] bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 border-0 shrink-0">
                                آفر {toFa(p.offer)}
                              </Badge>
                            )}
                          </div>
                          {sel && (
                            <div className="mt-2 grid grid-cols-2 gap-2">
                              <div className="space-y-0.5">
                                <Label className="text-[10px]">تعداد</Label>
                                <Input
                                  className="h-7 text-xs"
                                  inputMode="numeric"
                                  value={sel.quantity}
                                  onChange={(e) => patchSelected(p.id, { quantity: Math.max(1, Number(e.target.value) || 1) })}
                                />
                              </div>
                              <div className="space-y-0.5">
                                <Label className="text-[10px]">جمع ردیف</Label>
                                <div className="h-7 flex items-center justify-end px-2 rounded-md bg-secondary/60 text-[11px] font-bold">
                                  {formatMoney(lineTotal(sel))}
                                </div>
                              </div>
                              {/* آفر دستی خالی */}
                              <div className="col-span-2 space-y-0.5">
                                <Label className="text-[10px] flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                                  <Gift className="h-3 w-3" /> آفر دستی (خالی)
                                </Label>
                                <Input
                                  className="h-7 text-xs border-emerald-500/30"
                                  value={sel.offer}
                                  onChange={(e) => patchSelected(p.id, { offer: e.target.value })}
                                  placeholder={p.offer ? `پیشنهاد: ${p.offer} — دلخواه وارد کنید` : "مثلاً 1+8"}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          )}

          {selectedList.length > 0 && (
            <div className="sticky bottom-20 rounded-xl border border-primary/30 bg-card shadow-lg p-3 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold">{toFa(selectedList.length)} کالا انتخاب شده</span>
                <span className="font-black text-primary">{formatMoney(total)} تومان</span>
              </div>
              {/* وضعیت تسویه فاکتور — قبل از دکمه ثبت (نقد / چک پای بار / رسید + سررسید) */}
              <InvoiceSettlementFields value={settlement} onChange={patchSettlement} />
              <div className="flex gap-2">
                <Button className="flex-1" size="sm" onClick={openInvoice}>
                  <FileText className="h-4 w-4" /> صدور فاکتور فروش
                </Button>
                <Button className="flex-1" size="sm" variant="secondary" onClick={submitOrder} disabled={saving}>
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />} ثبت سریع سفارش
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* سوابق سفارش */}
      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="text-xs font-bold flex items-center gap-1.5">
            <ClipboardList className="h-3.5 w-3.5 text-primary" /> سوابق سفارش مشتری
          </div>
          {orders.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-3">سفارشی ثبت نشده است</p>
          ) : (
            orders.map((o) => (
              <div key={o.id} className="rounded-lg bg-secondary/50 p-2.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-bold">{formatJalaliDateTime(o.createdAt)}</span>
                  <span className="font-black text-primary">{formatMoney(o.totalAmount)}</span>
                </div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[10px] text-muted-foreground">
                    {toFa(o.items.length)} ردیف • {priceTypeLabel(o.priceType)}
                  </span>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => setView("order-detail", { orderId: o.id, customerId: customer!.id })}>
                      مشاهده
                    </Button>
                    <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-destructive" onClick={() => removeOrder(o)}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* سند PDF پروفایل */}
      <OffscreenDoc id="customer-profile-doc">
        <CustomerProfileDocument customer={customer} orders={orders} />
      </OffscreenDoc>
    </div>
  );
}

function CustomerProfileDocument({ customer, orders }: { customer: Customer; orders: Order[] }) {
  return (
    <div style={{ padding: "36px 32px", minHeight: 800 }}>
      <PdfBrandHeader title="پروفایل مشتری" />

      <div style={{ background: GOLD_SOFT, borderRadius: 12, padding: 16, marginTop: 4, fontSize: 12, lineHeight: 2 }}>
        <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 4 }}>{customer.name}</div>
        {customer.company && <div>شرکت: {customer.company}</div>}
        <div>نوع: {CUSTOMER_TYPES.find((t) => t.key === customer.type)?.label}</div>
        <div>تلفن: {customer.phone}</div>
        {customer.address && <div>آدرس: {customer.address}</div>}
        {customer.nationalId && <div>کد ملی: {customer.nationalId}</div>}
      </div>

      <div style={{ fontSize: 14, fontWeight: 800, margin: "22px 0 10px", color: GOLD }}>
        سوابق سفارش ({toFa(orders.length)} سفارش)
      </div>
      {orders.length === 0 ? (
        <div style={{ fontSize: 11, color: "#a8a29e" }}>سفارشی ثبت نشده است</div>
      ) : (
        orders.map((o) => (
          <div key={o.id} style={{ border: `1px solid ${LINE}`, borderRadius: 10, padding: 12, marginBottom: 10, fontSize: 11 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, marginBottom: 6 }}>
              <span>
                {formatJalaliDateTime(o.createdAt)} — {priceTypeLabel(o.priceType)}
              </span>
              <span style={{ color: GOLD }}>{formatMoney(o.totalAmount)} تومان</span>
            </div>
            {o.items.map((it) => (
              <div key={it.id} style={{ color: "#57534e", display: "flex", justifyContent: "space-between" }}>
                <span>
                  • {it.productName} × {toFa(it.quantity)} {it.offer ? `(آفر: ${toFa(it.offer)})` : ""}
                </span>
                <span>{formatMoney(it.lineTotal)}</span>
              </div>
            ))}
          </div>
        ))
      )}

      <PdfFooter text="تولید شده توسط اپلیکیشن ویزیتو (VIZITO)" />
    </div>
  );
}

function defaultTypeFor(customerType: string): string {
  if (customerType === "PHARMACY") return "PHARMACY";
  if (customerType === "SALON") return "SALON";
  return "STORE";
}
