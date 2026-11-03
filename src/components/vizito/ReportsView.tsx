"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { PdfExportButtons, OffscreenDoc } from "@/components/vizito/PdfExport";
import { PdfBrandHeader, PdfFooter, th, td, theadStyle, INK, GOLD, GOLD_SOFT, LINE, MUTED } from "@/components/vizito/PdfDocs";
import { api } from "@/lib/api";
import { FA_MONTHS, formatJalali, formatMoney, toFa, jalaliToIso, jalaliOf } from "@/lib/jalali";
import { priceTypeLabel } from "@/lib/sections";
import { useApp } from "@/lib/store";
import type { Customer, Order, ProductGroup } from "@/lib/types";
import { toast } from "@/hooks/use-toast";
import { BarChart3, Users, Package, Gift, MapPin, Lock } from "lucide-react";

export function ReportsView() {
  const { can } = useApp();
  const canPurchase = can("purchase_price");
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [range, setRange] = useState<{ from?: string; to?: string }>({});

  const load = useCallback(async (r: { from?: string; to?: string }) => {
    const qs = new URLSearchParams();
    if (r.from) qs.set("from", r.from);
    if (r.to) qs.set("to", r.to);
    try {
      const [o, c, g] = await Promise.all([
        api<Order[]>(`/api/orders?${qs.toString()}`),
        api<Customer[]>("/api/customers"),
        api<ProductGroup[]>("/api/groups"),
      ]);
      setOrders(o);
      setCustomers(c);
      setGroups(g);
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
      setOrders([]);
    }
  }, []);

  useEffect(() => {
    load(range);
  }, [load, range]);

  const customerName = (id: string) => customers.find((c) => c.id === id)?.name || "—";
  const totalSales = (orders || []).reduce((s, o) => s + o.totalAmount, 0);

  return (
    <div className="space-y-3 app-fade">
      <h1 className="font-bold text-lg flex items-center gap-2">
        <BarChart3 className="h-5 w-5 text-primary" /> گزارشات
      </h1>

      <Tabs defaultValue="orders">
        <TabsList className="grid grid-cols-3 w-full">
          <TabsTrigger value="orders">سفارشات</TabsTrigger>
          <TabsTrigger value="customers">مشتریان</TabsTrigger>
          <TabsTrigger value="products">کالاها</TabsTrigger>
        </TabsList>

        {/* گزارش سفارشات */}
        <TabsContent value="orders" className="space-y-2 mt-3">
          <DateRangePicker onChange={(r) => setRange(r)} />
          {!orders ? (
            <Skeleton className="h-40 w-full rounded-xl" />
          ) : (
            <>
              <Card>
                <CardContent className="p-3 flex items-center justify-between">
                  <div className="text-xs">
                    <div className="font-bold">{toFa(orders.length)} سفارش</div>
                    <div className="text-muted-foreground mt-0.5">در بازه انتخابی</div>
                  </div>
                  <div className="text-left">
                    <div className="text-lg font-black text-primary">{formatMoney(totalSales)}</div>
                    <div className="text-[9px] text-muted-foreground">مجموع فروش (تومان)</div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-3 space-y-2 max-h-96 overflow-y-auto">
                  {orders.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-6">سفارشی در این بازه نیست</p>
                  ) : (
                    orders.map((o) => (
                      <div key={o.id} className="flex items-center justify-between text-xs bg-secondary/50 rounded-lg px-3 py-2">
                        <span className="font-bold truncate max-w-[40%]">{customerName(o.customerId)}</span>
                        <span className="text-[10px] text-muted-foreground">{formatJalali(o.createdAt)}</span>
                        <Badge variant="secondary" className="text-[9px]">{priceTypeLabel(o.priceType)}</Badge>
                        <span className="font-bold text-primary">{formatMoney(o.totalAmount)}</span>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-3">
                  <div className="text-xs font-bold mb-2">خروجی گزارش سفارشات</div>
                  <PdfExportButtons
                    docId="orders-report-doc"
                    filename="vizito-report-orders.pdf"
                    layout="grid"
                  />
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        {/* گزارش مشتریان — شامل آدرس */}
        <TabsContent value="customers" className="space-y-2 mt-3">
          <Card>
            <CardContent className="p-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold flex items-center gap-1.5">
                  <Users className="h-4 w-4 text-primary" /> تعداد مشتریان
                </span>
                <span className="text-lg font-black">{toFa(customers.length)}</span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 space-y-2 max-h-96 overflow-y-auto">
              {customers.map((c) => {
                const cOrders = orders?.filter((o) => o.customerId === c.id) || [];
                const cTotal = cOrders.reduce((s, o) => s + o.totalAmount, 0);
                return (
                  <div key={c.id} className="text-xs bg-secondary/50 rounded-lg px-3 py-2 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-bold">{c.name}</span>
                      <span className="font-bold text-primary">{formatMoney(cTotal)}</span>
                    </div>
                    <div className="flex justify-between text-[10px] text-muted-foreground">
                      <span>{toFa(cOrders.length)} سفارش</span>
                      <span dir="ltr">{toFa(c.phone)}</span>
                    </div>
                    {c.address && (
                      <div className="flex items-start gap-1 text-[10px] text-muted-foreground">
                        <MapPin className="h-3 w-3 shrink-0 mt-0.5" />
                        <span>{c.address}</span>
                      </div>
                    )}
                  </div>
                );
              })}
              {customers.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-6">مشتری ثبت نشده است</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <div className="text-xs font-bold mb-2">خروجی گزارش مشتریان (با آدرس)</div>
              <PdfExportButtons
                docId="customers-report-doc"
                filename="vizito-report-customers.pdf"
                layout="grid"
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* گزارش کالاها */}
        <TabsContent value="products" className="space-y-2 mt-3">
          <Card>
            <CardContent className="p-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold flex items-center gap-1.5">
                  <Package className="h-4 w-4 text-primary" /> گروه‌ها و کالاها
                </span>
                <span className="text-sm font-black">
                  {toFa(groups.length)} گروه • {toFa(groups.reduce((s, g) => s + g.products.length, 0))} کالا
                </span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 space-y-3 max-h-96 overflow-y-auto">
              {groups.map((g) => (
                <div key={g.id}>
                  <div className="text-[11px] font-bold mb-1.5 flex items-center gap-1">
                    <Package className="h-3 w-3 text-primary" /> {g.name}
                    <Badge variant="secondary" className="text-[9px]">{toFa(g.products.length)}</Badge>
                  </div>
                  <div className="space-y-1">
                    {g.products.map((p) => (
                      <div key={p.id} className="flex items-center justify-between text-[11px] bg-secondary/50 rounded px-2.5 py-1.5">
                        <span className="font-medium truncate max-w-[45%]">{p.name}</span>
                        {p.offer && (
                          <Badge variant="secondary" className="text-[9px] gap-0.5 bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-0">
                            <Gift className="h-2 w-2" /> {toFa(p.offer)}
                          </Badge>
                        )}
                        <span className="text-muted-foreground">فروشگاه: {formatMoney(p.priceStore)}</span>
                      </div>
                    ))}
                    {g.products.length === 0 && <p className="text-[10px] text-muted-foreground">— خالی</p>}
                  </div>
                </div>
              ))}
              {groups.length === 0 && <p className="text-xs text-muted-foreground text-center py-6">کالایی ثبت نشده است</p>}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 space-y-2">
              <div className="text-xs font-bold">خروجی گزارش کالاها</div>
              <PdfExportButtons
                docId="products-report-doc"
                filename="vizito-report-products.pdf"
                layout="grid"
              />
              {canPurchase ? (
                <>
                  <Separator />
                  <div className="text-xs font-bold">خروجی لیست قیمت خرید (ویژه مدیر)</div>
                  <PdfExportButtons
                    docId="purchase-price-doc"
                    filename="vizito-purchase-price-list.pdf"
                    layout="grid"
                  />
                </>
              ) : (
                <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <Lock className="h-3 w-3" /> خروجی قیمت خرید فقط با اجازه مدیر فعال می‌شود
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* اسناد PDF */}
      {orders && (
        <>
          <OffscreenDoc id="orders-report-doc">
            <OrdersReportDocument orders={orders} customerName={customerName} from={range.from} to={range.to} />
          </OffscreenDoc>
          <OffscreenDoc id="customers-report-doc">
            <CustomersReportDocument customers={customers} orders={orders || []} />
          </OffscreenDoc>
          <OffscreenDoc id="products-report-doc">
            <ProductsReportDocument groups={groups} canPurchase={canPurchase} />
          </OffscreenDoc>
          {canPurchase && (
            <OffscreenDoc id="purchase-price-doc">
              <PurchasePriceDocument groups={groups} />
            </OffscreenDoc>
          )}
        </>
      )}
    </div>
  );
}

function Separator() {
  return <div className="h-px bg-border" />;
}

function DateRangePicker({ onChange }: { onChange: (r: { from?: string; to?: string }) => void }) {
  const today = jalaliOf(new Date());
  const [from, setFrom] = useState<{ jy: number; jm: number; jd: number } | null>(null);
  const [to, setTo] = useState<{ jy: number; jm: number; jd: number } | null>(null);

  const years = useMemo(() => [today.jy - 2, today.jy - 1, today.jy, today.jy + 1], [today.jy]);

  const apply = (f: typeof from, t: typeof to) => {
    setFrom(f);
    setTo(t);
    onChange({
      from: f ? jalaliToIso(f.jy, f.jm, f.jd) : undefined,
      to: t ? jalaliToIso(t.jy, t.jm, t.jd) : undefined,
    });
  };

  const select = (value: string) => {
    if (value === "all") {
      apply(null, null);
      return;
    }
    if (value === "month") {
      apply({ jy: today.jy, jm: today.jm, jd: 1 }, { ...today });
      return;
    }
    if (value === "3month") {
      const d = new Date();
      d.setMonth(d.getMonth() - 3);
      const j = jalaliOf(d);
      apply({ jy: j.jy, jm: j.jm, jd: j.jd }, { ...today });
      return;
    }
  };

  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <Label className="text-xs font-bold">بازه گزارش</Label>
        <div className="flex gap-1.5 flex-wrap">
          <Button size="sm" variant="secondary" className="h-7 text-[11px]" onClick={() => select("month")}>
            این ماه
          </Button>
          <Button size="sm" variant="secondary" className="h-7 text-[11px]" onClick={() => select("3month")}>
            ۳ ماه اخیر
          </Button>
          <Button size="sm" variant="secondary" className="h-7 text-[11px]" onClick={() => select("all")}>
            همه
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[10px]">از تاریخ</Label>
            <JalaliDateSelects value={from} years={years} onChange={(v) => apply(v, to)} />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px]">تا تاریخ</Label>
            <JalaliDateSelects value={to} years={years} onChange={(v) => apply(from, v)} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function JalaliDateSelects({
  value,
  years,
  onChange,
}: {
  value: { jy: number; jm: number; jd: number } | null;
  years: number[];
  onChange: (v: { jy: number; jm: number; jd: number } | null) => void;
}) {
  const today = jalaliOf(new Date());
  const v = value || { jy: today.jy, jm: today.jm, jd: today.jd };
  return (
    <div className="grid grid-cols-3 gap-1">
      <Select value={String(v.jd)} onValueChange={(d) => onChange({ ...v, jd: Number(d) })}>
        <SelectTrigger className="h-8 text-[10px] px-1.5">
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
      <Select value={String(v.jm)} onValueChange={(m) => onChange({ ...v, jm: Number(m) })}>
        <SelectTrigger className="h-8 text-[10px] px-1.5">
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
      <Select value={String(v.jy)} onValueChange={(y) => onChange({ ...v, jy: Number(y) })}>
        <SelectTrigger className="h-8 text-[10px] px-1.5">
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
  );
}

// ---------- اسناد PDF ----------

function OrdersReportDocument({
  orders,
  customerName,
  from,
  to,
}: {
  orders: Order[];
  customerName: (id: string) => string;
  from?: string;
  to?: string;
}) {
  const total = orders.reduce((s, o) => s + o.totalAmount, 0);
  return (
    <div style={{ padding: "32px", minHeight: 1000 }}>
      <PdfBrandHeader title="گزارش سفارشات" />
      <div style={{ fontSize: 11, color: MUTED, marginBottom: 10 }}>
        بازه: {from ? formatJalali(from) : "ابتدا"} تا {to ? formatJalali(to) : "اکنون"} — تعداد: {toFa(orders.length)} سفارش
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
        <thead>
          <tr style={theadStyle}>
            <th style={th}>#</th>
            <th style={th}>مشتری</th>
            <th style={th}>تاریخ</th>
            <th style={th}>نوع قیمت</th>
            <th style={th}>اقلام</th>
            <th style={th}>مبلغ</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o, i) => (
            <tr key={o.id} style={{ borderBottom: `1px solid ${LINE}` }}>
              <td style={td}>{toFa(i + 1)}</td>
              <td style={td}>{customerName(o.customerId)}</td>
              <td style={td}>{formatJalali(o.createdAt)}</td>
              <td style={td}>{priceTypeLabel(o.priceType)}</td>
              <td style={td}>{toFa(o.items?.length ?? 0)}</td>
              <td style={{ ...td, fontWeight: 700 }}>{formatMoney(o.totalAmount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
        <div style={{ background: INK, color: "#e9d9b5", borderRadius: 8, padding: "8px 18px", fontSize: 13, fontWeight: 800 }}>
          مجموع فروش: {formatMoney(total)} تومان
        </div>
      </div>
      <PdfFooter text="گزارش تولیدشده توسط اپلیکیشن ویزیتو (VIZITO)" />
    </div>
  );
}

/** گزارش مشتریان — طبق درخواست، آدرس مشتری در خروجی هست */
function CustomersReportDocument({ customers, orders }: { customers: Customer[]; orders: Order[] }) {
  return (
    <div style={{ padding: "32px", minHeight: 1000 }}>
      <PdfBrandHeader title="گزارش مشتریان" />
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10.5 }}>
        <thead>
          <tr style={theadStyle}>
            <th style={th}>#</th>
            <th style={th}>نام / شرکت</th>
            <th style={th}>تلفن</th>
            <th style={th}>کد ملی</th>
            <th style={th}>آدرس</th>
            <th style={th}>سفارش‌ها</th>
            <th style={th}>مجموع خرید</th>
          </tr>
        </thead>
        <tbody>
          {customers.map((c, i) => {
            const cOrders = orders.filter((o) => o.customerId === c.id);
            const cTotal = cOrders.reduce((s, o) => s + o.totalAmount, 0);
            return (
              <tr key={c.id} style={{ borderBottom: `1px solid ${LINE}` }}>
                <td style={td}>{toFa(i + 1)}</td>
                <td style={{ ...td, textAlign: "right" }}>
                  {c.name}
                  {c.company ? ` — ${c.company}` : ""}
                </td>
                <td style={td}>{toFa(c.phone)}</td>
                <td style={td}>{c.nationalId ? toFa(c.nationalId) : "-"}</td>
                <td style={{ ...td, textAlign: "right", maxWidth: 180, fontSize: 9.5, color: "#57534e" }}>
                  {c.address || "-"}
                </td>
                <td style={td}>{toFa(cOrders.length)}</td>
                <td style={{ ...td, fontWeight: 700 }}>{formatMoney(cTotal)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <PdfFooter text="گزارش تولیدشده توسط اپلیکیشن ویزیتو (VIZITO)" />
    </div>
  );
}

/** گزارش کالاها — ستون قیمت خرید فقط برای کاربر مجاز */
function ProductsReportDocument({ groups, canPurchase }: { groups: ProductGroup[]; canPurchase: boolean }) {
  return (
    <div style={{ padding: "32px", minHeight: 1000 }}>
      <PdfBrandHeader title="گزارش کالاها" />
      {groups.map((g) => (
        <div key={g.id} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: GOLD, marginBottom: 6 }}>گروه: {g.name}</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
            <thead>
              <tr style={{ background: GOLD_SOFT, color: INK }}>
                <th style={th}>کالا</th>
                <th style={th}>حجم</th>
                <th style={th}>آفر</th>
                {canPurchase && <th style={th}>خرید</th>}
                <th style={th}>فروشگاه</th>
                <th style={th}>داروخانه</th>
                <th style={th}>سالن</th>
                <th style={th}>تخفیف</th>
              </tr>
            </thead>
            <tbody>
              {g.products.map((p) => (
                <tr key={p.id} style={{ borderBottom: `1px solid ${LINE}` }}>
                  <td style={td}>{p.name}</td>
                  <td style={td}>{p.volume ? toFa(p.volume) : "-"}</td>
                  <td style={{ ...td, color: p.offer ? "#8a6d1f" : "#a8a29e", fontWeight: 700 }}>
                    {p.offer ? toFa(p.offer) : "-"}
                  </td>
                  {canPurchase && <td style={td}>{formatMoney(p.pricePurchase ?? 0)}</td>}
                  <td style={td}>{formatMoney(p.priceStore)}</td>
                  <td style={td}>{formatMoney(p.pricePharmacy)}</td>
                  <td style={td}>{formatMoney(p.priceSalon)}</td>
                  <td style={td}>{p.discount > 0 ? `${toFa(p.discount)}٪` : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <PdfFooter text="گزارش تولیدشده توسط اپلیکیشن ویزیتو (VIZITO)" />
    </div>
  );
}

/** لیست قیمت خرید — فقط مدیر یا کاربر دارای دسترسی ویژه */
function PurchasePriceDocument({ groups }: { groups: ProductGroup[] }) {
  const grand = groups.reduce(
    (sum, g) => sum + g.products.reduce((s, p) => s + (p.pricePurchase ?? 0), 0),
    0
  );
  return (
    <div style={{ padding: "32px", minHeight: 1000 }}>
      <PdfBrandHeader title="لیست قیمت خرید (محرمانه)" />
      <div style={{ fontSize: 10.5, color: MUTED, marginBottom: 12 }}>
        این سند شامل قیمت خرید است و فقط برای مدیر یا کاربران دارای دسترسی ویژه صادر می‌شود.
      </div>
      {groups.map((g) => {
        const subtotal = g.products.reduce((s, p) => s + (p.pricePurchase ?? 0), 0);
        return (
          <div key={g.id} style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: GOLD, marginBottom: 6 }}>گروه: {g.name}</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
              <thead>
                <tr style={theadStyle}>
                  <th style={th}>کالا</th>
                  <th style={th}>حجم</th>
                  <th style={th}>قیمت خرید</th>
                  <th style={th}>فروشگاه</th>
                  <th style={th}>حاشیه سود</th>
                </tr>
              </thead>
              <tbody>
                {g.products.map((p) => {
                  const purchase = p.pricePurchase ?? 0;
                  const margin = purchase > 0 ? Math.round(((p.priceStore - purchase) / purchase) * 100) : 0;
                  return (
                    <tr key={p.id} style={{ borderBottom: `1px solid ${LINE}` }}>
                      <td style={td}>{p.name}</td>
                      <td style={td}>{p.volume ? toFa(p.volume) : "-"}</td>
                      <td style={{ ...td, fontWeight: 700 }}>{formatMoney(purchase)}</td>
                      <td style={td}>{formatMoney(p.priceStore)}</td>
                      <td style={{ ...td, color: margin > 0 ? "#5c6b4c" : MUTED }}>{margin > 0 ? `${toFa(margin)}٪` : "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ fontSize: 10, color: MUTED, marginTop: 4, textAlign: "left" }}>
              جمع خرید گروه: {formatMoney(subtotal)} تومان
            </div>
          </div>
        );
      })}
      <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
        <div style={{ background: INK, color: "#e9d9b5", borderRadius: 8, padding: "8px 18px", fontSize: 13, fontWeight: 800 }}>
          جمع کل ارزش خرید: {formatMoney(grand)} تومان
        </div>
      </div>
      <PdfFooter text="سند محرمانه — ویزیتو (VIZITO)" />
    </div>
  );
}
