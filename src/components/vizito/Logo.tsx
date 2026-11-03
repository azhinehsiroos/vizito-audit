"use client";

import Image from "next/image";
import { useApp } from "@/lib/store";

/**
 * لوگوی پویا — اگر مدیر لوگوی سفارشی گذاشته باشد همان نمایش داده می‌شود،
 * وگرنه لوگوی پیش‌فرض ویزیتو.
 */
export function Logo({
  size = 32,
  className = "",
  priority = false,
}: {
  size?: number;
  className?: string;
  priority?: boolean;
}) {
  const logo = useApp((s) => s.logo);
  return (
    <Image
      src={logo || "/vizito-logo.svg"}
      alt="لوگوی ویزیتو"
      width={size}
      height={size}
      priority={priority}
      unoptimized
      className={`object-contain ${className}`}
    />
  );
}
