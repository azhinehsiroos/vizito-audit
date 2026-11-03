"use client";

import { useTheme } from "next-themes";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { JalaliCalendar } from "@/components/vizito/JalaliCalendar";
import { Logo } from "@/components/vizito/Logo";
import { useApp } from "@/lib/store";
import { api, saveFallbackToken } from "@/lib/api";
import { fileToCompressedDataUrl } from "@/lib/image";
import { expiryLabel, toFa, formatJalali } from "@/lib/jalali";
import { useEffect, useRef, useState, useCallback } from "react";
import { toast } from "@/hooks/use-toast";
import {
  Moon,
  Settings,
  LogOut,
  Crown,
  Info,
  CalendarDays,
  ImageUp,
  RotateCcw,
  Loader2,
  ShieldCheck,
  KeyRound,
  Copy,
  RefreshCw,
  Pencil,
  Check,
  Gem,
  ChevronLeft,
  LockKeyhole,
  Eye,
  EyeOff,
} from "lucide-react";

export function SettingsView() {
  const { theme, setTheme } = useTheme();
  const { me, setMe, setView, logo, setLogo } = useApp();
  const [mounted, setMounted] = useState(false);
  const [savingLogo, setSavingLogo] = useState(false);
  const logoFileRef = useRef<HTMLInputElement>(null);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  useEffect(() => setMounted(true), []);

  // ویرایش پروفایل — نام و نام شرکت
  const [editingProfile, setEditingProfile] = useState(false);
  const [profileForm, setProfileForm] = useState({ name: "", company: "" });
  const [savingProfile, setSavingProfile] = useState(false);

  const isOwner = !!me?.isOwner;

  // تغییر رمز عبور — همه کاربران
  const [pwForm, setPwForm] = useState({ current: "", next: "", confirm: "" });
  const [showPw, setShowPw] = useState({ current: false, next: false, confirm: false });
  const [savingPw, setSavingPw] = useState(false);

  // کد دعوت ثبت‌نام — فقط مدیر
  useEffect(() => {
    if (me?.isAdmin) {
      api<{ inviteCode: string }>("/api/settings/invite")
        .then((r) => setInviteCode(r.inviteCode))
        .catch(() => {});
    }
  }, [me?.isAdmin]);

  const startProfileEdit = () => {
    setProfileForm({ name: me?.name ?? "", company: me?.company ?? "" });
    setEditingProfile(true);
  };

  const saveProfile = async () => {
    if (!me) return;
    if (!profileForm.name.trim()) {
      toast({ title: "خطا", description: "نام را وارد کنید", variant: "destructive" });
      return;
    }
    setSavingProfile(true);
    try {
      const res = await api<{
        user: { id: string; mobile: string; name: string; company: string | null; role: string };
      }>("/api/auth/me", {
        method: "PUT",
        body: { name: profileForm.name.trim(), company: profileForm.company.trim() },
      });
      setMe({ ...me, name: res.user.name, company: res.user.company });
      setEditingProfile(false);
      toast({ title: "پروفایل ذخیره شد ✅", description: "نام و نام شرکت به‌روزرسانی شد" });
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSavingProfile(false);
    }
  };

  const savePassword = async () => {
    if (!pwForm.current || !pwForm.next) {
      toast({ title: "خطا", description: "رمز فعلی و رمز جدید را وارد کنید", variant: "destructive" });
      return;
    }
    if (pwForm.next.length < 8) {
      toast({ title: "خطا", description: "رمز جدید باید حداقل ۸ کاراکتر باشد", variant: "destructive" });
      return;
    }
    if (pwForm.next !== pwForm.confirm) {
      toast({ title: "خطا", description: "رمز جدید و تکرار آن یکسان نیست", variant: "destructive" });
      return;
    }
    setSavingPw(true);
    try {
      await api("/api/auth/change-password", {
        method: "POST",
        body: { currentPassword: pwForm.current, newPassword: pwForm.next },
      });
      setPwForm({ current: "", next: "", confirm: "" });
      toast({ title: "رمز عبور تغییر کرد ✅", description: "نشست‌های دیگر شما باطل شد؛ از این پس با رمز جدید وارد شوید" });
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSavingPw(false);
    }
  };

  const regenerateInvite = async () => {
    setRegenerating(true);
    try {
      const r = await api<{ inviteCode: string }>("/api/settings/invite", { method: "POST" });
      setInviteCode(r.inviteCode);
      toast({ title: "کد دعوت جدید ساخته شد", description: "کد قبلی دیگر قابل استفاده نیست" });
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setRegenerating(false);
    }
  };

  const copyInvite = async () => {
    if (!inviteCode) return;
    try {
      await navigator.clipboard.writeText(inviteCode);
      toast({ title: "کپی شد ✅", description: "کد دعوت در حافظه گوشی کپی شد" });
    } catch {
      toast({ title: "کد دعوت", description: inviteCode });
    }
  };

  const logout = () => {
    // ابطال سمت سرور نشست (کوکی HttpOnly پاک می‌شود) + پاک‌سازی سمت کلاینت + توکن پشتیبان
    api("/api/auth/logout", { method: "POST" }).catch(() => {});
    saveFallbackToken(null);
    setMe(null);
    setView("dashboard");
  };

  const uploadLogo = async (file: File | undefined) => {
    if (!file) return;
    setSavingLogo(true);
    try {
      const dataUrl = await fileToCompressedDataUrl(file, 512);
      const res = await api<{ logo: string | null }>("/api/settings", {
        method: "PUT",
        body: { logo: dataUrl },
      });
      setLogo(res.logo);
      toast({ title: "لوگو به‌روزرسانی شد ✅", description: "لوگوی جدید در کل برنامه و اسناد PDF اعمال شد" });
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSavingLogo(false);
    }
  };

  const resetLogo = async () => {
    setSavingLogo(true);
    try {
      await api("/api/settings", { method: "PUT", body: { logo: null } });
      setLogo(null);
      toast({ title: "لوگوی پیش‌فرض ویزیتو بازیابی شد" });
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSavingLogo(false);
    }
  };

  return (
    <div className="space-y-3 app-fade">
      <h1 className="font-bold text-lg flex items-center gap-2">
        <Settings className="h-5 w-5 text-primary" /> تنظیمات
      </h1>

      {/* حساب کاربری */}
      <Card>
        <CardContent className="p-3 space-y-1.5 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-bold text-sm">{me?.name}</span>
            <div className="flex items-center gap-1.5">
              {me?.isAdmin && (
                <Badge className="text-[9px] gap-1 bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-0">
                  <Crown className="h-2.5 w-2.5" /> مدیر کل
                </Badge>
              )}
              {me && !editingProfile && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11px] gap-1"
                  onClick={startProfileEdit}
                  aria-label="ویرایش نام"
                >
                  <Pencil className="h-3 w-3" /> ویرایش نام
                </Button>
              )}
            </div>
          </div>
          <div className="text-muted-foreground" dir="ltr">
            {toFa(me?.mobile ?? "")}
          </div>
          {editingProfile ? (
            <div className="space-y-2 pt-1">
              <div className="space-y-1">
                <Label htmlFor="profile-name" className="text-[11px] text-muted-foreground">
                  نام
                </Label>
                <Input
                  id="profile-name"
                  value={profileForm.name}
                  onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })}
                  placeholder="نام شما"
                  className="h-9 text-[13px]"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="profile-company" className="text-[11px] text-muted-foreground">
                  نام شرکت (اختیاری)
                </Label>
                <Input
                  id="profile-company"
                  value={profileForm.company}
                  onChange={(e) => setProfileForm({ ...profileForm, company: e.target.value })}
                  placeholder="مثلاً شرکت زیبایی آرتا"
                  className="h-9 text-[13px]"
                />
              </div>
              <div className="flex gap-1.5 pt-0.5">
                <Button size="sm" onClick={saveProfile} disabled={savingProfile}>
                  {savingProfile ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  ذخیره
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditingProfile(false)} disabled={savingProfile}>
                  انصراف
                </Button>
              </div>
            </div>
          ) : (
            me?.company && <div className="text-muted-foreground">شرکت: {me.company}</div>
          )}
          {me && !me.isAdmin && me.grantExpiresAt && (
            <div className="rounded-lg bg-secondary/60 p-2 mt-1">
              اعتبار دسترسی: <b>{expiryLabel(me.grantExpiresAt)}</b>
            </div>
          )}
          {me && !me.isAdmin && !me.grantExpiresAt && (
            <div className="rounded-lg bg-destructive/10 text-destructive p-2 mt-1">
              دسترسی فعالی ندارید — با مدیر تماس بگیرید
            </div>
          )}
          <Separator className="my-2" />
          <button
            onClick={logout}
            className="w-full flex items-center justify-center gap-2 text-destructive font-bold py-1.5 hover:bg-destructive/10 rounded-lg transition-colors"
          >
            <LogOut className="h-4 w-4" /> خروج از حساب
          </button>
        </CardContent>
      </Card>

      {/* تغییر رمز عبور — همه کاربران */}
      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="text-xs font-bold flex items-center gap-1.5">
            <LockKeyhole className="h-3.5 w-3.5 text-primary" /> تغییر رمز عبور
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">رمز عبور فعلی</Label>
            <div className="relative">
              <Input
                type={showPw.current ? "text" : "password"}
                dir="ltr"
                value={pwForm.current}
                onChange={(e) => setPwForm((f) => ({ ...f, current: e.target.value }))}
                className="h-9 pl-9"
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setShowPw((s) => ({ ...s, current: !s.current }))}
                aria-label={showPw.current ? "مخفی کردن رمز" : "نمایش رمز"}
                className="absolute left-1 top-1/2 -translate-y-1/2 h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
              >
                {showPw.current ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">رمز جدید</Label>
              <div className="relative">
                <Input
                  type={showPw.next ? "text" : "password"}
                  dir="ltr"
                  value={pwForm.next}
                  onChange={(e) => setPwForm((f) => ({ ...f, next: e.target.value }))}
                  className="h-9 pl-9"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((s) => ({ ...s, next: !s.next }))}
                  aria-label={showPw.next ? "مخفی کردن رمز" : "نمایش رمز"}
                  className="absolute left-1 top-1/2 -translate-y-1/2 h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
                >
                  {showPw.next ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">تکرار رمز جدید</Label>
              <div className="relative">
                <Input
                  type={showPw.confirm ? "text" : "password"}
                  dir="ltr"
                  value={pwForm.confirm}
                  onChange={(e) => setPwForm((f) => ({ ...f, confirm: e.target.value }))}
                  className="h-9 pl-9"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((s) => ({ ...s, confirm: !s.confirm }))}
                  aria-label={showPw.confirm ? "مخفی کردن رمز" : "نمایش رمز"}
                  className="absolute left-1 top-1/2 -translate-y-1/2 h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
                >
                  {showPw.confirm ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
          </div>
          <Button size="sm" onClick={savePassword} disabled={savingPw}>
            {savingPw ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            ذخیره رمز جدید
          </Button>
        </CardContent>
      </Card>

      {/* لایسنس برنامه — فقط مدیر */}
      {me?.isAdmin && <LicenseCard />}

      {/* فروش لایسنس — فقط سازنده برنامه (بخش اختصاصی) */}
      {isOwner && (
        <Card className="border-primary/30">
          <CardContent className="p-3">
            <button onClick={() => setView("license-sales")} className="w-full flex items-center justify-between gap-2 text-right" aria-label="رفتن به فروش لایسنس">
              <span className="text-xs font-bold flex items-center gap-1.5">
                <Gem className="h-3.5 w-3.5 text-primary" /> فروش لایسنس
              </span>
              <ChevronLeft className="h-4 w-4 text-muted-foreground" />
            </button>
            <p className="text-[10px] text-muted-foreground mt-1 leading-4">
              دفتر خریداران لایسنس، پروفایل خریدار، شارژ مجدد و حذف — بخش اختصاصی سازنده برنامه (از منوی همبرگری هم در دسترس است)
            </p>
          </CardContent>
        </Card>
      )}

      {/* لوگو و برند — فقط مدیر */}
      {me?.isAdmin && (
        <Card>
          <CardContent className="p-3 space-y-2.5">
            <div className="text-xs font-bold flex items-center gap-1.5">
              <ImageUp className="h-3.5 w-3.5 text-primary" /> لوگو و برند
            </div>
            <div className="flex items-center gap-3">
              <div className="w-16 h-16 rounded-2xl border border-border bg-secondary/40 flex items-center justify-center overflow-hidden">
                <Logo size={56} />
              </div>
              <div className="flex-1 text-[10px] text-muted-foreground leading-5">
                لوگو در هدر برنامه، صفحه ورود، منو و همه اسناد PDF (فاکتور، کاتالوگ، گزارشات) اعمال می‌شود.
                تصویر مربعی با پس‌زمینه تیره پیشنهاد می‌شود.
              </div>
            </div>
            <div className="flex gap-1.5">
              <Button size="sm" variant="secondary" onClick={() => logoFileRef.current?.click()} disabled={savingLogo}>
                {savingLogo ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageUp className="h-4 w-4" />}
                تغییر لوگو
              </Button>
              <Button size="sm" variant="ghost" onClick={resetLogo} disabled={savingLogo || !logo}>
                <RotateCcw className="h-4 w-4" /> بازگشت به پیش‌فرض
              </Button>
            </div>
            <input
              ref={logoFileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => uploadLogo(e.target.files?.[0])}
            />
          </CardContent>
        </Card>
      )}

      {/* امنیت و ثبت‌نام — فقط مدیر */}
      {me?.isAdmin && (
        <Card>
          <CardContent className="p-3 space-y-2">
            <div className="text-xs font-bold flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-primary" /> امنیت و ثبت‌نام
            </div>
            <div className="text-[10px] text-muted-foreground leading-5">
              ثبت‌نام کاربران جدید فقط با این کد دعوت امکان‌پذیر است. برای واگذاری دسترسی به ویزیتور جدید،
              کد را برای او بفرستید؛ برای قطع ثبت‌نام‌های ناخواسته، کد جدید بسازید.
            </div>
            <div className="flex items-center gap-2">
              <div
                dir="ltr"
                className="flex-1 h-9 rounded-lg bg-secondary/60 border border-border flex items-center justify-center font-mono font-bold tracking-[0.25em] text-sm select-all"
              >
                {inviteCode || "·······"}
              </div>
              <Button size="sm" variant="secondary" className="h-9" onClick={copyInvite} disabled={!inviteCode} aria-label="کپی کد دعوت">
                <Copy className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="ghost" className="h-9" onClick={regenerateInvite} disabled={regenerating} aria-label="کد دعوت جدید">
                {regenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              </Button>
            </div>
            <div className="text-[10px] text-muted-foreground flex items-center gap-1">
              <KeyRound className="h-3 w-3" /> ورود/ثبت‌نام محدود به تعداد تلاش است؛ نشست‌ها حداکثر ۳۰ روز اعتبار دارند.
            </div>
          </CardContent>
        </Card>
      )}

      {/* دارک مود */}
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Moon className="h-4 w-4 text-primary" />
              <Label htmlFor="dark-mode" className="text-sm">حالت دارک مود</Label>
            </div>
            {mounted && (
              <Switch
                id="dark-mode"
                checked={theme === "dark"}
                onCheckedChange={(v) => setTheme(v ? "dark" : "light")}
              />
            )}
          </div>
        </CardContent>
      </Card>

      {/* تقویم */}
      <Card>
        <CardContent className="p-3">
          <div className="text-xs font-bold flex items-center gap-1.5 mb-1">
            <CalendarDays className="h-3.5 w-3.5 text-primary" /> تقویم هجری شمسی
          </div>
          <JalaliCalendar compact />
        </CardContent>
      </Card>

      {/* درباره */}
      <Card>
        <CardContent className="p-3 space-y-1.5">
          <div className="text-xs font-bold flex items-center gap-1.5">
            <Info className="h-3.5 w-3.5 text-primary" /> درباره ویزیتو
          </div>
          <p className="text-[11px] text-muted-foreground leading-6">
            اپلیکیشن ویزیت محصولات آرایشی و بهداشتی — مدیریت مشتریان، کالاها، سفارشات، کاتالوگ و گزارشات با
            خروجی PDF و ذخیره خودکار در پوشه «ویزیتو» داخل Downloads گوشی. تقویم هجری شمسی، دارک مود، دسترسی زمان‌دار
            کاربران و کنترل دسترسی قیمت خرید.
          </p>
          <div className="text-[10px] text-muted-foreground">VIZITO © نسخه ۲.۰</div>
        </CardContent>
      </Card>
    </div>
  );
}

/** کارت وضعیت لایسنس (مدیر) — نمایش اعتبار + شارژ مجدد با کلید جدید */
function LicenseCard() {
  const [state, setState] = useState<{
    activated: boolean; valid: boolean; name: string | null; mobile: string | null; expiresAt: string | null; daysLeft: number | null; ownerUnlocked?: boolean; installId?: string | null;
  } | null>(null);
  const [newKey, setNewKey] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<{
        activated: boolean; valid: boolean; name: string | null; mobile: string | null; expiresAt: string | null; daysLeft: number | null; ownerUnlocked?: boolean; installId?: string;
      }>("/api/license/status");
      setState(data);
    } catch {
      /* بی‌صدا */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const recharge = async () => {
    if (!newKey.trim()) {
      toast({ title: "کلید جدید را وارد کنید", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/license/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: newKey.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "کلید نامعتبر است");
      toast({ title: "لایسنس شارژ شد ✅", description: `اعتبار تا ${data.expiresAt ? expiryLabel(data.expiresAt) : "—"}` });
      setNewKey("");
      await load();
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  if (!state) {
    return (
      <Card>
        <CardContent className="p-3 text-xs text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> در حال دریافت وضعیت لایسنس...
        </CardContent>
      </Card>
    );
  }

  const expired = state.activated && !state.valid;
  return (
    <Card className={expired ? "border-destructive/40" : "border-primary/30"}>
      <CardContent className="p-3 space-y-2 text-xs">
        <div className="flex items-center justify-between">
          <span className="font-bold text-sm flex items-center gap-1.5">
            <KeyRound className="h-4 w-4 text-primary" /> لایسنس برنامه
          </span>
          {state.ownerUnlocked ? (
            <Badge className="text-[9px] gap-1 bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border-0">
              <Crown className="h-2.5 w-2.5" /> همیشگی
            </Badge>
          ) : state.valid ? (
            <Badge className="text-[9px] bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border-0">
              فعال
            </Badge>
          ) : (
            <Badge variant="destructive" className="text-[9px]">منقضی / غیرفعال</Badge>
          )}
        </div>
        {state.activated ? (
          state.ownerUnlocked ? (
            <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200/70 dark:border-emerald-900/60 p-2 flex items-start gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
              <div className="leading-5">
                <div className="font-bold text-emerald-700 dark:text-emerald-300">
                  دسترسی همیشگی سازنده برنامه — بدون محدودیت زمانی
                </div>
                <div className="text-[10px] text-muted-foreground">
                  این سرور برای سازنده برنامه باز است و نیازی به شارژ لایسنس ندارد.
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-1 text-muted-foreground leading-5">
              <div>دارنده لایسنس: <b className="text-foreground">{state.name}</b>{state.mobile ? ` — ${toFa(state.mobile)}` : ""}</div>
              <div>
                اعتبار: <b className={expired ? "text-destructive" : "text-foreground"}>{state.expiresAt ? expiryLabel(state.expiresAt) : "—"}</b>
                {state.valid && state.daysLeft !== null && state.daysLeft > 0 && <span> — معادل {toFa(state.daysLeft)} روز</span>}
              </div>
            </div>
          )
        ) : (
          <div className="text-muted-foreground">هنوز لایسنس فعال نشده است.</div>
        )}
        <Separator className="my-1" />
        {state.installId && (
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold text-muted-foreground">شناسه نصب این سرور (Install ID)</span>
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[10px] shrink-0"
                onClick={() => {
                  void navigator.clipboard.writeText(state.installId || "");
                  toast({ title: "کپی شد ✅", description: "این شناسه را برای فروشنده برنامه بفرستید" });
                }}
              >
                <Copy className="h-3 w-3" /> کپی
              </Button>
            </div>
            <div
              dir="ltr"
              className="rounded-lg bg-secondary/60 border border-border px-2 py-1.5 font-mono text-[12px] font-bold text-center select-all"
            >
              {state.installId}
            </div>
            <p className="text-[9px] text-muted-foreground leading-4">
              این شناسه مانند «اثر انگشت» همین نصب است و هرگز تغییر نمی‌کند. برای دریافت/تمدید کلید لایسنس، آن را کپی
              کنید و برای فروشنده برنامه بفرستید — کلید صادرشده فقط روی همین نصب کار می‌کند.
            </p>
          </div>
        )}
        <Label className="text-[11px] text-muted-foreground">شارژ / تمدید با کلید جدید</Label>
        <div className="flex gap-2">
          <Input
            dir="ltr"
            placeholder="VZT2...."
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            className="font-mono text-[12px] h-9"
          />
          <Button size="sm" onClick={recharge} disabled={busy} className="h-9 shrink-0">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            شارژ
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground leading-4">
          با انقضای لایسنس، اطلاعات پاک نمی‌شود؛ با شارژ مجدد همه‌چیز ادامه می‌یابد.
        </p>
      </CardContent>
    </Card>
  );
}
