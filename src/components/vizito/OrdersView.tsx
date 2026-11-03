"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
import { useApp } from "@/lib/store";
import { api } from "@/lib/api";
import { formatMoney, formatJalali, toFa } from "@/lib/jalali";
import { visiblePriceTypes, priceOfProduct, priceTypeLabel } from "@/lib/sections";
import type { Customer, Order, ProductGroup } from "@/lib/types";
import { toast } from "@/hooks/use-toast";
import { InvoiceSettlementFields, type InvoiceSettlementValue } from "@/components/vizito/SettlementSection";
import {
  Plus,
  ClipboardList,
  Gift,
  Eye,
  Loader2,
  User,
  Percent,
  Package,
  PackageCheck,
  X,
  Lock,
  Check,
} from "lucide-react";

/**
 * ردیف فاکتور — فقط از انتخاب کالا ساخته می‌شود (هرگز ردیف دستی/خالی وجود ندارد)
 */
type DraftItem = {
  productId: string;
  productName: string;
  quantity: number;
  volume: string;
  price: number;
  discount: number;
  offer: string; // آفر دستی — خالی
};

export function OrdersView() {
  const { setView } = useApp();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);

  const load = useCallback(async () => {
    try {
      const [o, c] = await Promise.all([api<Order[]>("/api/orders"), api<Customer[]>("/api/customers")]);
      setOrders(o);
      setCustomers(c);
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
      setOrders([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const customerName = (id: string) => customers.find((c) => c.id === id)?.name || "—";

  const openDetail = (o: Order) => {
    setView("order-detail", { orderId: o.id });
  };

  return (
    <div className="space-y-3 app-fade">
      <div className="flex items-center justify-between">
        <h1 className="font-bold text-lg">فاکتورهای فروش</h1>
        <Button size="sm" onClick={() => setView("order-form", { customerId: "" })}>
          <Plus className="h-4 w-4" /> فاکتور جدید
        </Button>
      </div>

      {!orders ? (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full rounded-xl" />
          <Skeleton className="h-20 w-full rounded-xl" />
        </div>
      ) : orders.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center space-y-2">
            <ClipboardList className="h-10 w-10 text-muted-foreground/40 mx-auto" />
            <p className="text-sm text-muted-foreground">هنوز فاکتوری ثبت نشده است</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {orders.map((o) => (
            <Card key={o.id} className="hover:border-primary/40 transition-colors cursor-pointer" onClick={() => openDetail(o)}>
              <CardContent className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-sm flex items-center gap-1">
                        <User className="h-3.5 w-3.5 text-primary" /> {customerName(o.customerId)}
                      </span>
                      <Badge variant="secondary" className="text-[9px]">
                        {visiblePriceTypes(true).find((t) => t.key === o.priceType)?.label || o.priceType}
                      </Badge>
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-1">
                      {toFa(o.items?.length ?? 0)} ردیف • {formatJalali(o.createdAt)}
                      {o.title ? ` • ${o.title}` : ""}
                    </div>
                  </div>
                  <div className="text-left shrink-0">
                    <div className="font-black text-sm text-primary">{formatMoney(o.totalAmount)}</div>
                    <div className="text-[9px] text-muted-foreground">تومان</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export function OrderForm() {
  const { setView, params, can } = useApp();
  const canPurchase = can("purchase_price");
  // حالت ویرایش: در صورت داشتن params.orderId فرم از سفارش موجود پیش‌پر می‌شود
  const editId = params.orderId;
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [lockedCustomer, setLockedCustomer] = useState(false);
  const [fromProfile, setFromProfile] = useState(false);
  const [title, setTitle] = useState("");
  const [priceType, setPriceType] = useState("STORE");
  const [note, setNote] = useState("");
  const [items, setItems] = useState<DraftItem[]>([]);
  const [settlement, setSettlement] = useState<InvoiceSettlementValue>({ settlementType: "", dueDays: "" });

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

  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      try {
        const [c, g] = await Promise.all([api<Customer[]>("/api/customers"), api<ProductGroup[]>("/api/groups")]);
        if (cancelled) return;
        setCustomers(c);
        setGroups(g);

        // ویرایش فاکتور موجود — پیش‌پرکردن فرم از سفارش ثبت‌شده (پیش‌نویس پروفایل نادیده گرفته می‌شود)
        if (editId) {
          const order = await api<Order>(`/api/orders/${editId}`);
          if (cancelled) return;
          setCustomerId(order.customerId);
          setLockedCustomer(true);
          setFromProfile(false);
          setTitle(order.title || "");
          setPriceType(order.priceType || "STORE");
          setNote(order.note || "");
          setSettlement({
            settlementType: order.settlementType || "",
            dueDays: order.dueDays ? String(order.dueDays) : "",
          });
          setItems(
            (order.items || []).map((it) => ({
              // ردیف‌های بدون کالای واقعی (دستی) با کلید مصنوعی و بدون productId واقعی
              productId: it.productId || `manual-${it.id}`,
              productName: it.productName,
              quantity: it.quantity,
              volume: it.volume || "",
              price: it.price,
              discount: it.discount,
              offer: it.offer || "",
            }))
          );
          return;
        }

        // ورود از پروفایل مشتری؟
        const draft = useApp.getState().invoiceDraft;
        if (draft && draft.customerId) {
          const cust = c.find((x) => x.id === draft.customerId);
          const pt = cust ? defaultTypeFor(cust.type) : "STORE";
          setCustomerId(draft.customerId);
          setLockedCustomer(true);
          setFromProfile(true);
          setPriceType(pt);
          const built: DraftItem[] = [];
          for (const [pid, sel] of Object.entries(draft.selections)) {
            const product = g.flatMap((gr) => gr.products).find((p) => p.id === pid);
            if (!product) continue;
            built.push({
              productId: product.id,
              productName: product.name,
              volume: product.volume || "",
              price: priceOfProduct(product, pt),
              discount: product.discount,
              quantity: sel.quantity || 1,
              offer: sel.offer || "",
            });
          }
          setItems(built);
          useApp.getState().setInvoiceDraft(null);
        } else if (params.customerId) {
          setCustomerId(params.customerId);
          setFromProfile(true);
          const cust = c.find((x) => x.id === params.customerId);
          if (cust) setPriceType(defaultTypeFor(cust.type));
        }
      } catch (e) {
        toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    boot();
    return () => {
      cancelled = true;
    };
  }, [editId, params.customerId]);

  useEffect(() => {
    // تغییر نوع قیمت → بازمحاسبه قیمت ردیف‌ها (ردیف‌ها خودکار از کالا ساخته شده‌اند)
    // در حالت ویرایش قیمت‌های ثبت‌شده ردیف‌ها حفظ می‌شود (بازمحاسبه از کاتالوگ انجام نمی‌شود)
    if (editId) return;
    setItems((prev) =>
      prev.map((it) => {
        const product = findProduct(it.productId);
        if (!product) return it;
        return { ...it, price: priceOfProduct(product, priceType) };
      })
    );
  }, [priceType, findProduct, editId]);

  /** تیک خوردن/نخوردن کالا → ساخت/حذف خودکار ردیف (بدون هیچ ردیف دستی) */
  const toggleProduct = (productId: string, checked: boolean) => {
    setItems((prev) => {
      if (!checked) return prev.filter((it) => it.productId !== productId);
      if (prev.some((it) => it.productId === productId)) return prev;
      const product = findProduct(productId);
      if (!product) return prev;
      return [
        ...prev,
        {
          productId,
          productName: product.name,
          volume: product.volume || "",
          price: priceOfProduct(product, priceType),
          discount: product.discount,
          quantity: 1,
          offer: "",
        },
      ];
    });
  };

  const patchItem = (productId: string, patch: Partial<DraftItem>) => {
    setItems((prev) => prev.map((it) => (it.productId === productId ? { ...it, ...patch } : it)));
  };

  // فقط کالاهای واقعی تیک می‌خورند — ردیف‌های دستی (manual-) در چک‌لیست نیستند
  const checkedIds = useMemo(
    () => new Set(items.filter((it) => !it.productId.startsWith("manual-")).map((it) => it.productId)),
    [items]
  );

  const lineTotal = (it: DraftItem) => Math.max(0, Math.round(it.quantity * it.price * (1 - it.discount / 100)));
  const total = useMemo(() => items.reduce((s, it) => s + lineTotal(it), 0), [items]);

  const save = async () => {
    if (!customerId) {
      toast({ title: "خطا", description: "مشتری فاکتور را انتخاب کنید", variant: "destructive" });
      return;
    }
    const validItems = items.filter((it) => it.quantity > 0);
    if (validItems.length === 0) {
      toast({ title: "خطا", description: "حداقل یک کالا از بخش «انتخاب کالا» تیک بزنید", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const body = {
        customerId,
        title,
        priceType,
        note,
        items: validItems.map((it) => ({
          // ردیف‌های دستی بدون شناسه کالا ارسال می‌شوند
          productId: it.productId.startsWith("manual-") ? null : it.productId,
          productName: it.productName,
          quantity: it.quantity,
          volume: it.volume,
          price: it.price,
          discount: it.discount,
          offer: it.offer,
        })),
        settlementType: settlement.settlementType || null,
        dueDays: settlement.dueDays ? Number(settlement.dueDays) : null,
      };
      if (editId) {
        // ویرایش فاکتور موجود
        await api<Order>(`/api/orders/${editId}`, { method: "PUT", body });
        toast({ title: "فاکتور ویرایش شد ✅", description: "تغییرات فاکتور ذخیره شد" });
        setView("order-detail", { orderId: editId, ...(params.customerId ? { customerId: params.customerId } : {}) });
      } else {
        const order = await api<Order>("/api/orders", { method: "POST", body });
        toast({ title: "فاکتور فروش ثبت شد ✅", description: "فاکتور آماده خروجی PDF است" });
        setView("order-detail", { orderId: order.id, ...(fromProfile && customerId ? { customerId } : {}) });
      }
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const goBack = () => {
    if (editId) {
      setView("order-detail", { orderId: editId });
      return;
    }
    if (fromProfile && customerId) setView("customer-profile", { customerId });
    else setView("orders");
  };

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (customers.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center space-y-3">
          <User className="h-10 w-10 text-muted-foreground/40 mx-auto" />
          <p className="text-sm text-muted-foreground">برای صدور فاکتور ابتدا یک مشتری ثبت کنید</p>
          <Button size="sm" variant="secondary" onClick={() => setView("customers")}>
            رفتن به مشتریان
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3 app-fade">
      <div className="flex items-center justify-between">
        <h1 className="font-bold text-lg">{editId ? "ویرایش فاکتور فروش" : "فاکتور فروش"}</h1>
        <Button size="sm" variant="ghost" onClick={goBack}>
          بازگشت
        </Button>
      </div>

      {/* انتخاب مشتری */}
      <Card>
        <CardContent className="p-3 space-y-2.5">
          <div className="space-y-1.5">
            <Label>مشتری *</Label>
            <Select
              value={customerId}
              disabled={lockedCustomer}
              onValueChange={(v) => {
                setCustomerId(v);
                const cust = customers.find((c) => c.id === v);
                if (cust) setPriceType(defaultTypeFor(cust.type));
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="انتخاب مشتری ثبت‌شده" />
              </SelectTrigger>
              <SelectContent className="max-h-60">
                {customers.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} {c.company ? `(${c.company})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {lockedCustomer && (
              <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                <Lock className="h-3 w-3" /> مشتری ثابت است {fromProfile ? "(صدور فاکتور از پروفایل مشتری)" : ""}
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>نام فرم / عنوان</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="اختیاری" />
            </div>
            <div className="space-y-1.5">
              <Label>نوع قیمت</Label>
              <Select value={priceType} onValueChange={setPriceType}>
                <SelectTrigger>
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
          </div>
        </CardContent>
      </Card>

      {/* انتخاب کالا از گروه‌ها → ردیف‌ها خودکار ساخته می‌شوند */}
      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-bold flex items-center gap-1.5">
              <Package className="h-3.5 w-3.5 text-primary" /> انتخاب کالا از گروه‌ها
            </Label>
            {items.length > 0 && (
              <Badge variant="secondary" className="text-[10px]">
                {toFa(items.length)} کالا انتخاب شده
              </Badge>
            )}
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
                  <AccordionContent className="space-y-1.5 pb-2">
                    {g.products.length === 0 && (
                      <p className="text-[11px] text-muted-foreground text-center py-2">کالایی در این گروه نیست</p>
                    )}
                    {g.products.map((p) => {
                      const checked = checkedIds.has(p.id);
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => toggleProduct(p.id, !checked)}
                          aria-pressed={checked}
                          aria-label={`انتخاب ${p.name}`}
                          className={`w-full flex items-center gap-2 rounded-lg border p-2 text-right transition-colors ${
                            checked ? "border-primary/50 bg-primary/5" : "border-border hover:bg-accent/40"
                          }`}
                        >
                          {/* چک‌باکس بصری — تعامل با کلیک روی کل ردیف است */}
                          <span
                            className={`h-4 w-4 shrink-0 rounded-[4px] border flex items-center justify-center transition-colors ${
                              checked ? "bg-primary border-primary text-primary-foreground" : "border-input bg-background"
                            }`}
                          >
                            {checked && <Check className="h-3 w-3" strokeWidth={3} />}
                          </span>
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
                              {p.volume ? ` • ${p.volume}` : ""}
                            </div>
                          </div>
                          {p.offer && (
                            <Badge variant="secondary" className="text-[9px] bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 border-0 shrink-0">
                              آفر {toFa(p.offer)}
                            </Badge>
                          )}
                        </button>
                      );
                    })}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          )}
        </CardContent>
      </Card>

      {/* ردیف‌های فاکتور — خودکار از انتخاب کالا */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-bold">ردیف‌های فاکتور</Label>
          <span className="text-[10px] text-muted-foreground">خودکار از انتخاب کالا ساخته می‌شوند</span>
        </div>

        {items.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-center space-y-1.5">
              <PackageCheck className="h-8 w-8 text-muted-foreground/40 mx-auto" />
              <p className="text-xs text-muted-foreground leading-6">
                کالاهای فاکتور را از بخش «انتخاب کالا» تیک بزنید؛
                <br />
                ردیف‌ها به‌صورت خودکار همین‌جا ساخته می‌شوند.
              </p>
            </CardContent>
          </Card>
        ) : (
          items.map((it, idx) => {
            const product = findProduct(it.productId);
            return (
              <Card key={it.productId}>
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge variant="secondary" className="text-[10px] shrink-0">
                        ردیف {toFa(idx + 1)}
                      </Badge>
                      <span className="text-xs font-bold truncate">{it.productName}</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-destructive shrink-0"
                      onClick={() => toggleProduct(it.productId, false)}
                      aria-label={`حذف ${it.productName} از فاکتور`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>

                  {/* ستون‌های فاکتور: تعداد | تخفیف */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-[11px]">تعداد</Label>
                      <Input
                        inputMode="numeric"
                        className="h-9"
                        value={it.quantity}
                        onChange={(e) => patchItem(it.productId, { quantity: Math.max(0, Number(e.target.value) || 0) })}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px]">
                        <Percent className="h-2.5 w-2.5 inline" /> تخفیف٪
                      </Label>
                      <Input
                        inputMode="numeric"
                        className="h-9"
                        value={it.discount}
                        onChange={(e) => patchItem(it.productId, { discount: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-[11px]">قیمت واحد (تومان)</Label>
                      <Input
                        inputMode="numeric"
                        className="h-9"
                        value={it.price}
                        onChange={(e) => patchItem(it.productId, { price: Math.max(0, Number(e.target.value) || 0) })}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px]">جمع ردیف</Label>
                      <div className="h-9 flex items-center justify-end px-3 rounded-md bg-secondary/60 font-bold text-xs">
                        {formatMoney(lineTotal(it))}
                      </div>
                    </div>
                  </div>

                  {/* آفر ردیف — پیش‌از قیمت و تخفیف در ستون‌بندی فاکتور */}
                  <div className="rounded-lg border border-dashed border-emerald-500/40 bg-emerald-500/5 p-2 space-y-1">
                    <Label className="text-[11px] flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                      <Gift className="h-3 w-3" /> آفر این ردیف (دستی — خالی بماند اگر آفر ندارید)
                    </Label>
                    <Input
                      className="h-8 text-xs border-emerald-500/30"
                      value={it.offer}
                      onChange={(e) => patchItem(it.productId, { offer: e.target.value })}
                      placeholder={product?.offer ? `پیشنهاد سیستم: ${product.offer} — می‌توانید دلخواه بنویسید` : "مثلاً 1+8 یا 2 عدد رایگان"}
                    />
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      <div className="space-y-1.5">
        <Label>یادداشت فاکتور</Label>
        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="اختیاری..." />
      </div>

      {/* جمع کل */}
      <Card className="border-primary/30 bg-gradient-to-l from-primary/10 to-card">
        <CardContent className="p-3 flex items-center justify-between">
          <span className="text-sm font-bold">مبلغ کل فاکتور</span>
          <span className="text-lg font-black text-primary">
            {formatMoney(total)} <span className="text-[10px] font-normal">تومان</span>
          </span>
        </CardContent>
      </Card>

      {/* وضعیت تسویه فاکتور + سررسید */}
      <InvoiceSettlementFields value={settlement} onChange={(patch) => setSettlement((s) => ({ ...s, ...patch }))} />

      <Button className="w-full" size="lg" onClick={save} disabled={saving}>
        {saving && <Loader2 className="h-4 w-4 animate-spin" />} {editId ? "ذخیره تغییرات" : "ثبت فاکتور فروش"}
      </Button>
    </div>
  );
}

function defaultTypeFor(customerType: string): string {
  if (customerType === "PHARMACY") return "PHARMACY";
  if (customerType === "SALON") return "SALON";
  return "STORE";
}

export function OrderRowButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="sm" variant="ghost" onClick={onClick}>
      <Eye className="h-3.5 w-3.5" />
    </Button>
  );
}
