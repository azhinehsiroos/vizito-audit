"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PdfExportButtons, OffscreenDoc } from "@/components/vizito/PdfExport";
import { PdfLogo, PdfFooter, INK, GOLD, GOLD_SOFT, LINE, MUTED, GOLD_TEXT } from "@/components/vizito/PdfDocs";
import { api } from "@/lib/api";
import { formatMoney, toFa, formatJalali } from "@/lib/jalali";
import { CATALOG_PRICE_TYPES, priceFieldOf } from "@/lib/sections";
import type { ProductGroup } from "@/lib/types";
import { toast } from "@/hooks/use-toast";
import { BookOpen, Package } from "lucide-react";

export function CatalogView() {
  const [groups, setGroups] = useState<ProductGroup[] | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [withPrices, setWithPrices] = useState(true);

  useEffect(() => {
    api<ProductGroup[]>("/api/groups")
      .then((g) => {
        setGroups(g);
        setSelectedId(g[0]?.id || "");
      })
      .catch((e) => {
        toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
        setGroups([]);
      });
  }, []);

  const selected = groups?.find((g) => g.id === selectedId);

  if (!groups) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center space-y-2">
          <BookOpen className="h-10 w-10 text-muted-foreground/40 mx-auto" />
          <p className="text-sm text-muted-foreground">برای ساخت کاتالوگ ابتدا گروه و کالا ثبت کنید</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3 app-fade">
      <h1 className="font-bold text-lg">کاتالوگ محصولات</h1>

      <Card>
        <CardContent className="p-3 space-y-2.5">
          <div className="space-y-1.5">
            <div className="text-xs font-bold">انتخاب گروه برای کاتالوگ مجزا</div>
            <div className="flex flex-wrap gap-1.5">
              {groups.map((g) => (
                <button key={g.id} onClick={() => setSelectedId(g.id)}>
                  <Badge
                    variant={selectedId === g.id ? "default" : "secondary"}
                    className="cursor-pointer text-[11px] px-3 py-1.5"
                  >
                    {g.name} ({toFa(g.products.length)})
                  </Badge>
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs cursor-pointer w-fit">
            <input
              type="checkbox"
              checked={withPrices}
              onChange={(e) => setWithPrices(e.target.checked)}
              className="accent-[#96763f]"
            />
            نمایش قیمت‌های فروش در کاتالوگ
          </label>
          <p className="text-[10px] text-muted-foreground">
            طبق سیاست برند، قیمت خرید هرگز در کاتالوگ PDF درج نمی‌شود.
          </p>
        </CardContent>
      </Card>

      {selected && (
        <>
          <Card>
            <CardContent className="p-3 space-y-2">
              <div className="text-xs font-bold flex items-center gap-1.5">
                <BookOpen className="h-3.5 w-3.5 text-primary" /> خروجی کاتالوگ «{selected.name}»
              </div>
              <PdfExportButtons
                docId="catalog-doc"
                filename={`vizito-catalog-${selected.name}.pdf`}
                layout="grid"
              />
            </CardContent>
          </Card>

          {/* پیش‌نمایش ساده */}
          <div className="grid grid-cols-2 gap-2">
            {selected.products.map((p) => (
              <Card key={p.id} className="overflow-hidden">
                <div className="aspect-square bg-secondary/50 relative">
                  {p.image ? (
                    <img src={p.image} alt={p.name} className="absolute inset-0 w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Package className="h-10 w-10 text-muted-foreground/30" />
                    </div>
                  )}
                  {p.offer && (
                    <Badge className="absolute top-1.5 right-1.5 text-[9px] bg-[#96763f] text-white border-0">
                      آفر {toFa(p.offer)}
                    </Badge>
                  )}
                </div>
                <CardContent className="p-2">
                  <div className="text-[11px] font-bold truncate">{p.name}</div>
                  {withPrices && (
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      فروشگاه: {formatMoney(p.priceStore)} تومان
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}

      {/* سند کاتالوگ */}
      {selected && (
        <OffscreenDoc id="catalog-doc">
          <CatalogDocument group={selected} withPrices={withPrices} />
        </OffscreenDoc>
      )}
    </div>
  );
}

function CatalogDocument({ group, withPrices }: { group: ProductGroup; withPrices: boolean }) {
  return (
    <div style={{ minHeight: 1100, background: "#ffffff" }}>
      {/* جلد لوکس */}
      <div
        style={{
          background: `linear-gradient(150deg, #14110d 0%, ${INK} 55%, #2b241a 100%)`,
          color: "#fff",
          padding: "70px 40px",
          textAlign: "center",
        }}
      >
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}>
          <div
            style={{
              padding: 6,
              borderRadius: 26,
              background: "rgba(201,169,106,0.14)",
              border: "1px solid rgba(201,169,106,0.45)",
            }}
          >
            <PdfLogo size={84} />
          </div>
        </div>
        <div style={{ fontSize: 42, fontWeight: 900, color: GOLD_TEXT }}>ویزیتو</div>
        <div className="brand-word" style={{ fontSize: 13, color: GOLD_TEXT, opacity: 0.9, marginTop: 6, letterSpacing: 8 }}>
          VIZITO
        </div>
        <div style={{ width: 70, height: 1, background: GOLD, margin: "18px auto" }} />
        <div style={{ marginTop: 10, fontSize: 24, fontWeight: 800, color: "#fff" }}>
          کاتالوگ گروه «{group.name}»
        </div>
        <div style={{ marginTop: 16, fontSize: 12, opacity: 0.75, color: GOLD_TEXT }}>
          {formatJalali(new Date())} — {toFa(group.products.length)} محصول
        </div>
      </div>

      {/* محصولات */}
      <div style={{ padding: "28px 32px" }}>
        {group.products.length === 0 ? (
          <div style={{ textAlign: "center", color: "#a8a29e", fontSize: 12, padding: 40 }}>
            محصولی در این گروه ثبت نشده است
          </div>
        ) : (
          group.products.map((p, i) => (
            <div
              key={p.id}
              style={{
                display: "flex",
                gap: 16,
                border: `1px solid ${LINE}`,
                borderRadius: 14,
                padding: 14,
                marginBottom: 14,
                background: i % 2 ? GOLD_SOFT : "#fff",
              }}
            >
              <div
                style={{
                  width: 110,
                  height: 110,
                  borderRadius: 12,
                  overflow: "hidden",
                  background: "#f5f3ef",
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {p.image ? (
                  <img src={p.image} alt={p.name} style={{ objectFit: "cover", width: "100%", height: "100%" }} />
                ) : (
                  <span style={{ fontSize: 30, color: "#d6d3d1" }}>✦</span>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 15, fontWeight: 800 }}>{p.name}</span>
                  {p.volume && <span style={{ fontSize: 10, color: MUTED }}>حجم: {toFa(p.volume)}</span>}
                  {p.offer && (
                    <span style={{ fontSize: 10, background: GOLD, color: "#fff", borderRadius: 6, padding: "2px 8px", fontWeight: 700 }}>
                      آفر {toFa(p.offer)}
                    </span>
                  )}
                  {p.discount > 0 && (
                    <span style={{ fontSize: 10, background: INK, color: GOLD_TEXT, borderRadius: 6, padding: "2px 8px", fontWeight: 700 }}>
                      {toFa(p.discount)}٪ تخفیف
                    </span>
                  )}
                </div>
                {p.description && (
                  <p style={{ fontSize: 11, color: "#57534e", marginTop: 4, lineHeight: 1.8 }}>{p.description}</p>
                )}
                {withPrices && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                    {/* قیمت خرید طبق سیاست برند در کاتالوگ نمایش داده نمی‌شود */}
                    {CATALOG_PRICE_TYPES.map((t) => (
                      <span key={t.key} style={{ fontSize: 10, background: "#f5f3ef", border: `1px solid ${LINE}`, borderRadius: 6, padding: "3px 8px", color: "#44403c" }}>
                        {t.label}: <b>{formatMoney(p[priceFieldOf(t.key) as "priceStore"] as number)}</b>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))
        )}

        <PdfFooter text="کاتالوگ تولیدشده توسط اپلیکیشن ویزیتو (VIZITO)" />
      </div>
    </div>
  );
}
