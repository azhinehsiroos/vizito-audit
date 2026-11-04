"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { useApp } from "@/lib/store";
import { api } from "@/lib/api";
import { formatJalaliDateTime, toFa } from "@/lib/jalali";
import { toast } from "@/hooks/use-toast";
import {
  DatabaseBackup,
  FileJson,
  Download,
  Trash2,
  Loader2,
  CalendarClock,
  ShieldAlert,
  HardDrive,
  AlertTriangle,
  Hand,
  RefreshCw,
} from "lucide-react";

type BackupRow = {
  id: string;
  kind: string;
  sizeBytes: number;
  counts: string;
  createdByName: string | null;
  createdAt: string;
};

type BackupsResponse = {
  schedule: "off" | "daily" | "weekly" | "monthly";
  lastAuto: Record<string, string | null>;
  backups: BackupRow[];
};

const KIND_META: Record<string, { label: string; auto: boolean }> = {
  MANUAL: { label: "دستی", auto: false },
  DAILY: { label: "روزانه", auto: true },
  WEEKLY: { label: "هفتگی", auto: true },
  MONTHLY: { label: "ماهیانه", auto: true },
};

const SCHEDULE_OPTIONS: { key: "off" | "daily" | "weekly" | "monthly"; label: string }[] = [
  { key: "off", label: "خاموش" },
  { key: "daily", label: "روزانه" },
  { key: "weekly", label: "هفتگی" },
  { key: "monthly", label: "ماهیانه" },
];

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${toFa(bytes)} بایت`;
  return `${toFa((bytes / 1024).toFixed(1))} کیلوبایت`;
}

function parseCounts(json: string): { users?: number; customers?: number; products?: number; orders?: number } {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

export function BackupView() {
  const { me, setMe, setView } = useApp();
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [data, setData] = useState<BackupsResponse | null>(null);
  const [savingSchedule, setSavingSchedule] = useState<string | null>(null);
  // پاک‌سازی کامل
  const [resetOpen, setResetOpen] = useState(false);
  const [resetPassword, setResetPassword] = useState("");
  const [resetting, setResetting] = useState(false);

  const isAdmin = !!me?.isAdmin;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<BackupsResponse>("/api/backups");
      setData(res);
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) load();
    else setLoading(false);
  }, [isAdmin, load]);

  const createManual = async () => {
    setCreating(true);
    try {
      await api("/api/backups", { method: "POST" });
      toast({ title: "نسخه پشتیبان تهیه شد ✅", description: "نسخه جدید در فهرست پایین قابل دانلود است" });
      await load();
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const changeSchedule = async (value: BackupsResponse["schedule"]) => {
    if (!data || data.schedule === value) return;
    setSavingSchedule(value);
    const prev = data.schedule;
    setData({ ...data, schedule: value });
    try {
      await api("/api/backups/schedule", { method: "PUT", body: { schedule: value } });
      const label = SCHEDULE_OPTIONS.find((o) => o.key === value)?.label;
      toast({
        title: "زمان‌بندی ذخیره شد ✅",
        description: value === "off" ? "پشتیبان‌گیری خودکار خاموش شد" : `پشتیبان‌گیری خودکار ${label} فعال شد`,
      });
    } catch (e) {
      setData({ ...data, schedule: prev });
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSavingSchedule(null);
    }
  };

  /** دانلود امن: کوکی HttpOnly خودکار فرستاده می‌شود — فایل مستقیماً از API سرور می‌آید */
  const download = async (b: BackupRow) => {
    try {
      const res = await fetch(`/api/backups/${b.id}/download`);
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error || "دانلود ناموفق بود");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `vizito-backup-${formatJalaliDateTime(b.createdAt).replace(/[^\d]/g, "-")}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ title: "دانلود شروع شد ⬇️" });
    } catch (e) {
      toast({ title: "خطا در دانلود", description: (e as Error).message, variant: "destructive" });
    }
  };

  const remove = async (b: BackupRow) => {
    try {
      await api(`/api/backups/${b.id}`, { method: "DELETE" });
      toast({ title: "نسخه پشتیبان حذف شد" });
      await load();
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    }
  };

  const doReset = async () => {
    if (!resetPassword) return;
    setResetting(true);
    try {
      const res = await api<{ ok: boolean; backupsDeleted?: boolean }>("/api/admin/reset", {
        method: "POST",
        body: { password: resetPassword },
      });
      if (res?.backupsDeleted === false) {
        toast({
          title: "پاک‌سازی انجام شد ولی حذف فایل‌های پشتیبان ناموفق بود",
          description: "پوشه backups مسیر داده‌ها را روی هاست دستی بررسی کنید",
          variant: "destructive",
        });
      } else {
        toast({ title: "پاک‌سازی کامل انجام شد", description: "همه داده‌ها حذف شدند — حساب سازنده باقی مانده است" });
      }
      setResetOpen(false);
      setResetPassword("");
      // همه نشست‌ها حذف شده‌اند — پاک‌سازی کلاینت و بازگشت به صفحه ورود
      setMe(null);
      setView("dashboard");
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      toast({ title: "پاک‌سازی ناموفق", description: (e as Error).message, variant: "destructive" });
    } finally {
      setResetting(false);
    }
  };

  if (!isAdmin) {
    return (
      <Card className="max-w-sm mx-auto mt-8">
        <CardContent className="p-6 text-center space-y-2">
          <ShieldAlert className="h-10 w-10 text-destructive/60 mx-auto" />
          <h2 className="font-bold">دسترسی محدود</h2>
          <p className="text-xs text-muted-foreground">پشتیبان‌گیری فقط توسط مدیر برنامه امکان‌پذیر است.</p>
        </CardContent>
      </Card>
    );
  }

  const schedule = data?.schedule ?? "off";
  const backups = data?.backups ?? [];

  return (
    <div className="space-y-3 app-fade">
      <h1 className="font-bold text-lg flex items-center gap-2">
        <DatabaseBackup className="h-5 w-5 text-primary" />
        پشتیبان‌گیری
      </h1>

      {/* نسخه پشتیبان دستی */}
      <Card className="border-border/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Hand className="h-4 w-4 text-primary" />
            نسخه پشتیبان دستی
          </CardTitle>
          <CardDescription>
            همه اطلاعات برنامه (کاربران، مشتریان، کالاها، گروه‌ها، سفارشات و تنظیمات) در یک فایل ذخیره می‌شود.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button className="w-full" onClick={createManual} disabled={creating || loading}>
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <HardDrive className="h-4 w-4" />}
            تهیه نسخه پشتیبان الآن
          </Button>
        </CardContent>
      </Card>

      {/* پشتیبان‌گیری خودکار */}
      <Card className="border-border/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-primary" />
            پشتیبان‌گیری خودکار
          </CardTitle>
          <CardDescription>
            سرور به‌صورت خودکار در بازه انتخابی نسخه پشتیبان می‌گیرد؛ نسخه‌های قدیمی هر نوع به‌طور خودکار حذف می‌شوند.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-4 gap-2">
            {SCHEDULE_OPTIONS.map((o) => {
              const active = schedule === o.key;
              return (
                <Button
                  key={o.key}
                  variant={active ? "default" : "outline"}
                  size="sm"
                  className="h-9"
                  disabled={savingSchedule !== null}
                  onClick={() => changeSchedule(o.key)}
                  aria-pressed={active}
                >
                  {savingSchedule === o.key && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {o.label}
                </Button>
              );
            })}
          </div>
          {schedule !== "off" && data?.lastAuto && (
            <p className="text-[11px] text-muted-foreground">
              آخرین پشتیبان خودکار {KIND_META[schedule.toUpperCase()]?.label}:{" "}
              <span className="font-semibold">
                {data.lastAuto[schedule.toUpperCase()]
                  ? formatJalaliDateTime(data.lastAuto[schedule.toUpperCase()]!)
                  : "هنوز تهیه نشده — اولین نسخه به‌زودی ساخته می‌شود"}
              </span>
            </p>
          )}
        </CardContent>
      </Card>

      {/* فهرست نسخه‌ها */}
      <Card className="border-border/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <FileJson className="h-4 w-4 text-primary" />
            نسخه‌های پشتیبان
            {backups.length > 0 && (
              <Badge variant="secondary" className="text-[10px]">
                {toFa(backups.length)}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>فایل‌های پشتیبان فقط روی سرور نگهداری می‌شوند و دانلود آن‌ها فقط با حساب مدیر ممکن است.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-8 flex justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : backups.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">
              هنوز نسخه پشتیبانی تهیه نشده است.
            </p>
          ) : (
            <div className="max-h-96 overflow-y-auto space-y-2 pl-1">
              {backups.map((b) => {
                const meta = KIND_META[b.kind] || { label: b.kind, auto: false };
                const c = parseCounts(b.counts);
                return (
                  <div
                    key={b.id}
                    className="flex items-center gap-3 rounded-xl border border-border/60 bg-card p-3"
                  >
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-secondary/70 flex items-center justify-center">
                      <FileJson className="h-4 w-4 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Badge
                          variant="secondary"
                          className={`text-[10px] border-0 ${
                            meta.auto
                              ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                              : "bg-secondary text-secondary-foreground"
                          }`}
                        >
                          {meta.label}
                        </Badge>
                        <span className="text-xs font-semibold">{formatJalaliDateTime(b.createdAt)}</span>
                        <span className="text-[10px] text-muted-foreground">{fmtSize(b.sizeBytes)}</span>
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-0.5 truncate">
                        {c.users !== undefined &&
                          `کاربر: ${toFa(c.users)} • مشتری: ${toFa(c.customers ?? 0)} • کالا: ${toFa(
                            c.products ?? 0
                          )} • سفارش: ${toFa(c.orders ?? 0)}`}
                        {b.kind === "MANUAL" && b.createdByName ? ` — ${b.createdByName}` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="دانلود نسخه پشتیبان" onClick={() => download(b)}>
                        <Download className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        aria-label="حذف نسخه پشتیبان"
                        onClick={() => remove(b)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {!loading && backups.length > 0 && (
            <Button variant="ghost" size="sm" className="w-full mt-3 text-muted-foreground" onClick={load}>
              <RefreshCw className="h-3.5 w-3.5" />
              به‌روزرسانی فهرست
            </Button>
          )}
        </CardContent>
      </Card>

      {/* منطقه خطر — پاک‌سازی کامل (فقط سازنده برنامه) */}
      {me?.isOwner ? (
      <Card className="border-destructive/40">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-4 w-4" />
            پاک‌سازی کامل اطلاعات (خروجی نهایی)
          </CardTitle>
          <CardDescription>
            قبل از تحویل یا شروع مجدد، همه داده‌ها حذف می‌شوند — فقط سازندهٔ برنامه به این عملیات دسترسی دارد.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ul className="text-[11px] text-muted-foreground leading-6 list-disc pr-4">
            <li>همه کاربران — به‌جز حساب سازنده — حذف می‌شوند</li>
            <li>همه مشتریان، کالاها، گروه‌ها، سفارشات، پیام‌ها و تنظیمات (لوگو و کد دعوت) پاک می‌شوند</li>
            <li>همه نسخه‌های پشتیبان هم حذف می‌شوند تا هیچ داده‌ای باقی نماند</li>
            <li>برنامه خالی می‌شود و حساب شما (سازنده) باقی می‌ماند؛ برای تحویل کاملاً تازه، متغیرهای OWNER_MOBILES را از env حذف کنید</li>
          </ul>
          <Separator />
          <Button variant="destructive" className="w-full" onClick={() => setResetOpen(true)}>
            <ShieldAlert className="h-4 w-4" />
            پاک‌سازی کامل برنامه…
          </Button>
        </CardContent>
      </Card>
      ) : null}

      {/* تأیید پاک‌سازی با رمز مدیر */}
      <Dialog open={resetOpen} onOpenChange={(v) => { setResetOpen(v); if (!v) setResetPassword(""); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              پاک‌سازی کامل برنامه
            </DialogTitle>
            <DialogDescription>
              این عمل قابل بازگشت نیست و همه داده‌ها (به‌جز حساب سازنده) برای همیشه حذف می‌شوند. برای تأیید، رمز عبور سازنده را وارد کنید.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="reset-pass">رمز عبور مدیر</Label>
            <Input
              id="reset-pass"
              type="password"
              placeholder="••••••"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doReset()}
              autoComplete="current-password"
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setResetOpen(false)} disabled={resetting}>
              انصراف
            </Button>
            <Button variant="destructive" onClick={doReset} disabled={resetting || !resetPassword}>
              {resetting && <Loader2 className="h-4 w-4 animate-spin" />}
              حذف همه اطلاعات
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
