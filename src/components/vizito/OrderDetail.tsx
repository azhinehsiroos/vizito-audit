"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { PdfExportButtons, OffscreenDoc } from "@/components/vizito/PdfExport";
import { PdfBrandHeader, PdfFooter, PdfSettlementBlock, th, td, theadStyle, INK, GOLD_SOFT, LINE } from "@/components/vizito/PdfDocs";
import { SettlementChecklist, type OrderWithSettlement } from "@/components/vizito/SettlementSection";
import { useApp } from "@/lib/store";
import { api } from "@/lib/api";
import { formatJalali, formatJalaliDateTime, formatMoney, toFa } from "@/lib/jalali";
import { priceTypeLabel } from "@/lib/sections";
import type { Order } from "@/lib/types";
import { toast } from "@/hooks/use-toast";
import { ClipboardList, Gift, Pencil, Trash2, User, Building2, Phone, MapPin } from "lucide-react";

export function OrderDetail() {
  const { params, setView } = useApp();
  const [order, setOrder] = useState<OrderWithSettlement | null>(null);

  const load = useCallback(async () => {
    try {
      const o = await api<Order>(`/api/orders/${params.orderId}`);
      setOrder(o);
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    }
  }, [params.orderId]);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async () => {
    if (!order || !confirm("این سفارش حذف شود؟")) return;
    try {
      await api(`/api/orders/${order.id}`, { method: "DELETE" });
      toast({ title: "سفارش حذف شد" });
      setView("orders");
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    }
  };

  if (!order) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const filename = `vizito-invoice-${formatJalali(order.createdAt).replace(/\//g, "-")}.pdf`;

  return (
    <div className="space-y-3 app-fade">
      <div className="flex items-center justify-between">
        <h1 className="font-bold text-lg">فاکتور سفارش</h1>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setView("order-edit", { orderId: order.id, ...(params.customerId ? { customerId: params.customerId } : {}) })}
          >
            <Pencil className="h-4 w-4" /> ویرایش
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => (params.customerId ? setView("customer-profile", { customerId: params.customerId }) : setView("orders"))}
          >
            بازگشت
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive" onClick={remove}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* خروجی PDF */}
      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="text-xs font-bold flex items-center gap-1.5">
            <ClipboardList className="h-3.5 w-3.5 text-primary" /> خروجی PDF فاکتور
          </div>
          <PdfExportButtons docId="invoice-doc" filename={filename} layout="grid" />
        </CardContent>
      </Card>

      {/* اطلاعات */}
      <Card>
        <CardContent className="p-3 space-y-1.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-bold flex items-center gap-1">
              <User className="h-3.5 w-3.5 text-primary" /> {order.customer?.name}
            </span>
            <Badge variant="secondary" className="text-[9px]">
              {priceTypeLabel(order.priceType)}
            </Badge>
          </div>
          {order.customer?.company && (
            <div className="text-muted-foreground flex items-center gap-1">
              <Building2 className="h-3 w-3" /> {order.customer.company}
            </div>
          )}
          {order.customer?.phone && (
            <div className="text-muted-foreground flex items-center gap-1" dir="ltr">
              <Phone className="h-3 w-3" /> {toFa(order.customer.phone)}
            </div>
          )}
          {order.customer?.address && (
            <div className="text-muted-foreground flex items-center gap-1">
              <MapPin className="h-3 w-3" /> {order.customer.address}
            </div>
          )}
          <Separator />
          <div className="flex justify-between">
            <span className="text-muted-foreground">تاریخ ثبت</span>
            <span>{formatJalaliDateTime(order.createdAt)}</span>
          </div>
          {order.title && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">عنوان</span>
              <span>{order.title}</span>
            </div>
          )}
          {order.createdByUser && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">بازاریاب</span>
              <span>{order.createdByUser.name}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* اقلام */}
      <Card>
        <CardContent className="p-3">
          <div className="space-y-2">
            {order.items.map((it) => (
              <div key={it.id} className="rounded-lg bg-secondary/50 p-2.5 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs">
                    {toFa(it.rowNumber)}. {it.productName}
                  </span>
                  <span className="font-black text-xs text-primary">{formatMoney(it.lineTotal)}</span>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
                  <span>تعداد: {toFa(it.quantity)}</span>
                  <span>قیمت واحد: {formatMoney(it.price)}</span>
                  {it.discount > 0 && <span className="text-rose-600 dark:text-rose-400">تخفیف: {toFa(it.discount)}٪</span>}
                </div>
                {it.offer && (
                  <div className="text-[10px] text-emerald-700 dark:text-emerald-400 flex items-center gap-1 font-medium bg-emerald-500/10 rounded px-1.5 py-0.5 w-fit">
                    <Gift className="h-3 w-3" /> آفر دستی: {toFa(it.offer)}
                  </div>
                )}
              </div>
            ))}
          </div>
          <Separator className="my-2" />
          <div className="flex items-center justify-between">
            <span className="font-bold text-sm">مبلغ کل</span>
            <span className="font-black text-primary">{formatMoney(order.totalAmount)} تومان</span>
          </div>
          {order.note && <p className="text-[10px] text-muted-foreground mt-1">یادداشت: {order.note}</p>}
        </CardContent>
      </Card>

      {/* وضعیت تسویه فاکتور — نقد / چک پای بار / رسید + سررسید */}
      <Card>
        <CardContent className="p-3">
          <SettlementChecklist
            settlementType={order.settlementType}
            dueDays={order.dueDays}
            createdAt={order.createdAt}
          />
        </CardContent>
      </Card>

      {/* سند PDF مخفی */}
      <OffscreenDoc id="invoice-doc">
        <InvoiceDocument order={order} />
      </OffscreenDoc>
    </div>
  );
}

function InvoiceDocument({ order }: { order: OrderWithSettlement }) {
  return (
    <div style={{ padding: "36px 32px", minHeight: 1100 }}>
      <PdfBrandHeader title="فاکتور سفارش" />

      {/* مشخصات */}
      <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
        <div style={{ flex: 1, background: GOLD_SOFT, borderRadius: 12, padding: 14, fontSize: 12 }}>
          <div style={{ fontWeight: 800, marginBottom: 6, color: INK }}>مشخصات مشتری</div>
          <div>نام: {order.customer?.name}</div>
          {order.customer?.company && <div>شرکت: {order.customer.company}</div>}
          {order.customer?.phone && <div>تلفن: {order.customer.phone}</div>}
          {order.customer?.address && <div>آدرس: {order.customer.address}</div>}
          {order.customer?.nationalId && <div>کد ملی: {order.customer.nationalId}</div>}
        </div>
        <div style={{ flex: 1, background: "#f7f5f1", borderRadius: 12, padding: 14, fontSize: 12 }}>
          <div style={{ fontWeight: 800, marginBottom: 6, color: "#44403c" }}>مشخصات سفارش</div>
          <div>نوع قیمت: {priceTypeLabel(order.priceType)}</div>
          {order.title && <div>عنوان: {order.title}</div>}
          {order.createdByUser && <div>بازاریاب: {order.createdByUser.name}</div>}
          <div>تاریخ: {formatJalaliDateTime(order.createdAt)}</div>
        </div>
      </div>

      {/* جدول اقلام — فقط: نام کالا، تعداد، آفر، قیمت، تخفیف، جمع ردیف */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 20, fontSize: 11 }}>
        <thead>
          <tr style={theadStyle}>
            <th style={th}>نام کالا</th>
            <th style={th}>تعداد</th>
            <th style={th}>آفر</th>
            <th style={th}>قیمت</th>
            <th style={th}>تخفیف</th>
            <th style={th}>جمع ردیف</th>
          </tr>
        </thead>
        <tbody>
          {order.items.map((it) => (
            <tr key={it.id} style={{ borderBottom: `1px solid ${LINE}` }}>
              <td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{it.productName}</td>
              <td style={td}>{toFa(it.quantity)}</td>
              <td style={{ ...td, color: it.offer ? "#8a6d1f" : "#a8a29e", fontWeight: it.offer ? 700 : 400 }}>
                {it.offer ? toFa(it.offer) : "-"}
              </td>
              <td style={td}>{formatMoney(it.price)}</td>
              <td style={td}>{it.discount > 0 ? `${toFa(it.discount)}٪` : "-"}</td>
              <td style={{ ...td, fontWeight: 800 }}>{formatMoney(it.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* جمع */}
      <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
        <div style={{ background: INK, color: "#e9d9b5", borderRadius: 10, padding: "10px 22px", fontSize: 14, fontWeight: 800 }}>
          مبلغ کل: {formatMoney(order.totalAmount)} تومان
        </div>
      </div>

      {order.note && (
        <div style={{ marginTop: 14, fontSize: 11, color: "#57534e", background: "#f7f5f1", padding: 10, borderRadius: 8 }}>
          یادداشت: {order.note}
        </div>
      )}

      {/* وضعیت تسویه فاکتور — در خروجی PDF هم درج می‌شود */}
      <PdfSettlementBlock
        settlementType={order.settlementType}
        dueDays={order.dueDays}
        createdAt={order.createdAt}
      />

      <PdfFooter text={`این فاکتور توسط اپلیکیشن ویزیتو (VIZITO) تولید شده است — ${formatJalali(new Date())}`} />
    </div>
  );
}
