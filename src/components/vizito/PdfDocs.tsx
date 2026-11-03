"use client";

import Image from "next/image";
import { useApp } from "@/lib/store";
import { formatJalali, toFa } from "@/lib/jalali";

/** لوگوی داخل اسناد PDF — از تنظیمات برند پیروی می‌کند */
export function PdfLogo({ size = 56 }: { size?: number }) {
  const logo = useApp((s) => s.logo);
  return (
    <Image
      src={logo || "/vizito-logo.svg"}
      alt="VIZITO"
      width={size}
      height={size}
      unoptimized
      style={{ borderRadius: size / 4.5 }}
    />
  );
}

export const INK = "#1c1917";
export const GOLD = "#96763f";
export const GOLD_SOFT = "#f3eee2";
export const LINE = "#e5e0d6";
export const MUTED = "#7d7568";
export const GOLD_TEXT = "#e9d9b5";

/** سربرگ لوکس مشترک اسناد PDF */
export function PdfBrandHeader({ title }: { title: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        borderBottom: `2.5px solid ${GOLD}`,
        paddingBottom: 14,
        marginBottom: 18,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <PdfLogo size={54} />
        <div>
          <div style={{ fontSize: 21, fontWeight: 900, color: INK, lineHeight: 1.3 }}>ویزیتو</div>
          <div className="brand-word" style={{ fontSize: 9, color: GOLD, letterSpacing: 4 }}>
            VIZITO
          </div>
        </div>
      </div>
      <div style={{ textAlign: "left" }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: INK }}>{title}</div>
        <div style={{ fontSize: 10, color: MUTED, marginTop: 3 }}>{formatJalali(new Date())}</div>
      </div>
    </div>
  );
}

/** پانویس مشترک اسناد */
export function PdfFooter({ text }: { text: string }) {
  return (
    <div style={{ marginTop: 36, fontSize: 9.5, color: "#a8a29e", textAlign: "center" }}>
      <div style={{ width: 130, height: 1, background: GOLD, opacity: 0.5, margin: "0 auto 8px" }} />
      {text}
    </div>
  );
}

export const th: React.CSSProperties = {
  padding: "8px 6px",
  fontSize: 10.5,
  fontWeight: 700,
  textAlign: "center",
};

/**
 * چک‌لیست وضعیت تسویه در پایین فاکتور PDF:
 * ☑ نقد / ☐ چک پای بار / ☐ رسید + خط سررسید
 */
export function PdfSettlementBlock({
  settlementType,
  dueDays,
  createdAt,
}: {
  settlementType?: string | null;
  dueDays?: number | null;
  createdAt?: string | null;
}) {
  const options = [
    { key: "CASH", label: "نقد" },
    { key: "CHECK", label: "چک پای بار" },
    { key: "RECEIPT", label: "رسید" },
  ];
  let due = "";
  if (dueDays && dueDays > 0 && createdAt) {
    const created = new Date(createdAt);
    if (!Number.isNaN(created.getTime())) {
      due = `سررسید: تسویه ${toFa(dueDays)} روزه — تا ${formatJalali(new Date(created.getTime() + dueDays * 86400000))}`;
    }
  }
  return (
    <div style={{ marginTop: 18, background: GOLD_SOFT, borderRadius: 12, padding: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: GOLD, marginBottom: 8 }}>وضعیت تسویه فاکتور</div>
      <div style={{ display: "flex", gap: 10 }}>
        {options.map((o) => {
          const active = settlementType === o.key;
          return (
            <div
              key={o.key}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                border: `1px ${active ? "solid" : "dashed"} ${active ? GOLD : LINE}`,
                borderRadius: 8,
                padding: "6px 4px",
                fontSize: 11,
                fontWeight: active ? 800 : 400,
                color: active ? INK : MUTED,
                background: active ? "#ffffff" : "transparent",
              }}
            >
              <span
                style={{
                  width: 13,
                  height: 13,
                  border: `1.5px solid ${active ? GOLD : "#c9c2b4"}`,
                  borderRadius: 3,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: active ? GOLD : "#ffffff",
                  color: "#ffffff",
                  fontSize: 9,
                  lineHeight: 1,
                }}
              >
                {active ? "✓" : ""}
              </span>
              {o.label}
            </div>
          );
        })}
      </div>
      {!settlementType && (
        <div style={{ fontSize: 9.5, color: MUTED, marginTop: 6 }}>نحوه تسویه روی این فاکتور ثبت نشده است</div>
      )}
      {due && <div style={{ fontSize: 10.5, color: INK, marginTop: 8, fontWeight: 700 }}>{due}</div>}
    </div>
  );
}

export const td: React.CSSProperties = {
  padding: "7px 6px",
  textAlign: "center",
  color: "#292524",
};

/** استایل ردیف هدر جدول — زغالی با متن طلایی */
export const theadStyle: React.CSSProperties = {
  background: INK,
  color: GOLD_TEXT,
};
