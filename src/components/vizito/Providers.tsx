"use client";

import { ThemeProvider } from "next-themes";
import { useEffect, useState } from "react";

export function Providers({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
      {mounted ? children : <div suppressHydrationWarning>{children}</div>}
    </ThemeProvider>
  );
}
