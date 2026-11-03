"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { downloadBlob, elementToPdf } from "@/lib/pdf";
import { FileDown, Loader2 } from "lucide-react";

type Props = {
  docId: string;
  filename: string;
  layout?: "row" | "grid";
};

/** فقط خروجی PDF — بدون هیچ گزینه اشتراک‌گذاری؛ فایل مستقیم در پوشه «ویزیتو» داخل Downloads ذخیره می‌شود */
export function PdfExportButtons({ docId, filename, layout = "row" }: Props) {
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setBusy(true);
    try {
      const el = document.getElementById(docId);
      if (!el) throw new Error("سند یافت نشد");
      const { blob } = await elementToPdf(el, filename);
      downloadBlob(blob, filename);
      toast({
        title: "PDF آماده شد ✅",
        description: "فایل در پوشه «ویزیتو» داخل Downloads ذخیره شد",
      });
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={layout === "row" ? "flex gap-2" : "grid grid-cols-1 gap-2"}>
      <Button size="sm" onClick={download} disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
        خروجی PDF
      </Button>
    </div>
  );
}

/** ظرف مخفی برای رندر سند PDF خارج از صفحه */
export function OffscreenDoc({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <div
      id={id}
      dir="rtl"
      style={{
        position: "fixed",
        top: 0,
        right: -10000,
        width: 794,
        background: "#ffffff",
        color: "#1c1917",
        fontFamily: "Vazirmatn, Tahoma, sans-serif",
        zIndex: -1,
        pointerEvents: "none",
      }}
      aria-hidden
    >
      {children}
    </div>
  );
}
