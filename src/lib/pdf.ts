"use client";

import jsPDF from "jspdf";
import html2canvas from "html2canvas-pro";

const A4_WIDTH_MM = 210;
const A4_HEIGHT_MM = 297;
const PIXELS_PER_MM = 96 / 25.4;

export async function elementToPdf(
  el: HTMLElement,
  filename: string
): Promise<{ blob: Blob; filename: string }> {
  const scale = 2;
  const canvas = await html2canvas(el, {
    scale,
    useCORS: true,
    backgroundColor: "#ffffff",
    logging: false,
  });

  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = A4_WIDTH_MM;
  const pageH = A4_HEIGHT_MM;

  // ارتفاع واقعی محتوا (با احتساب scale) به میلی‌متر
  const cssWidth = el.offsetWidth || 794;
  const ratio = canvas.width / cssWidth;
  const contentHpx = canvas.height / ratio;
  const contentHmm = contentHpx / PIXELS_PER_MM;
  const pages = Math.max(1, Math.ceil(contentHmm / pageH));
  const pageSlicePx = pageH * PIXELS_PER_MM * ratio; // ارتفاع هر صفحه به پیکسل کانواس

  for (let i = 0; i < pages; i++) {
    const srcY = Math.floor(i * pageSlicePx);
    const srcH = Math.min(Math.ceil(pageSlicePx), canvas.height - srcY);
    if (srcH <= 0) break;
    if (i > 0) pdf.addPage();
    const pageCanvas = document.createElement("canvas");
    pageCanvas.width = canvas.width;
    pageCanvas.height = srcH;
    const ctx = pageCanvas.getContext("2d");
    if (!ctx) continue;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    ctx.drawImage(canvas, 0, srcY, canvas.width, srcH, 0, 0, canvas.width, srcH);
    const sliceHmm = srcH / ratio / PIXELS_PER_MM;
    pdf.addImage(pageCanvas.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, pageW, Math.min(sliceHmm, pageH), undefined, "FAST", 0);
  }

  // شماره صفحه
  const pagesCount = pdf.getNumberOfPages();
  for (let p = 1; p <= pagesCount; p++) {
    pdf.setPage(p);
    pdf.setFontSize(8);
    pdf.setTextColor(150);
    pdf.text(`${p} / ${pagesCount}`, pageW / 2, pageH - 4, { align: "center" });
  }

  const blob = pdf.output("blob");
  return { blob, filename };
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}


