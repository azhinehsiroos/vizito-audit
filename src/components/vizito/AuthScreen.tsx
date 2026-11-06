"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { initLocalDbForUser } from "@/lib/idb";
import { toast } from "@/hooks/use-toast";
import { Loader2, Sparkles, Lock, User, Building2, KeyRound, Rocket, Eye, EyeOff } from "lucide-react";
import { useApp } from "@/lib/store";
import { Logo } from "@/components/vizito/Logo";

export function AuthScreen() {
  const setMe = useApp((s) => s.setMe);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState("login");
  const [needsSetup, setNeedsSetup] = useState(false);
  const [login, setLogin] = useState({ mobile: "", password: "" });
  const [reg, setReg] = useState({ mobile: "", name: "", company: "", password: "", inviteCode: "", setupKey: "", setupToken: "" });
  const [showLoginPass, setShowLoginPass] = useState(false);
  const [showRegPass, setShowRegPass] = useState(false);
  // امنیت: شماره‌های سازنده داخل باندل عمومی نوشته نمی‌شوند — فیلد کلید فقط وقتی سرور ۴۰۳ با
  // کد OWNER_KEY_REQUIRED بدهد ظاهر می‌شود (و فیلد کد راه‌اندازی اولیه با SETUP_TOKEN_REQUIRED)
  const [showOwnerKey, setShowOwnerKey] = useState(false);
  const [showSetupToken, setShowSetupToken] = useState(false);

  // وضعیت راه‌اندازی اولیه: اگر هیچ حسابی وجود نداشته باشد، اولین ثبت‌نام مدیر می‌شود
  useEffect(() => {
    api<{ needsSetup: boolean }>("/api/auth/status")
      .then((r) => {
        if (r.needsSetup) {
          setNeedsSetup(true);
          setTab("register");
        }
      })
      .catch(() => {});
  }, []);

  const doLogin = async () => {
    if (!login.mobile.trim() || !login.password) {
      toast({ title: "خطا", description: "شماره موبایل و رمز عبور را وارد کنید", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: login,
      });
      // امنیت: نشست فقط با کوکی HttpOnly برقرار می‌شود (توکن به JS داده نمی‌شود و
      // در localStorage ذخیره نمی‌شود) — اگر کوکی در این بستر ذخیره نشود، کاربر
      // دوباره صفحه ورود می‌بیند (به‌جای نگه‌داری توکن در حافظه جاوااسکریپت)
      if (await loadMe()) {
        toast({ title: "خوش آمدید 👋", description: "با موفقیت وارد شدید" });
      } else {
        toast({
          title: "ورود انجام شد اما نشست برقرار نشد",
          description: "مرورگر اجازه ذخیره کوکی در این بستر نمی‌دهد — برنامه را در تب جدید باز کنید",
          variant: "destructive",
        });
      }
    } catch (e) {
      toast({ title: "ورود ناموفق", description: (e as Error).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const doRegister = async () => {
    if (!/^09\d{9}$/.test(reg.mobile.trim())) {
      toast({ title: "خطا", description: "شماره موبایل باید با ۰۹ شروع شده و ۱۱ رقم باشد", variant: "destructive" });
      return;
    }
    if (!reg.name.trim()) {
      toast({ title: "خطا", description: "نام / شرکت را وارد کنید", variant: "destructive" });
      return;
    }
    if (reg.password.length < 8) {
      toast({ title: "خطا", description: "رمز عبور حداقل ۸ کاراکتر باشد", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      const res = await api<{ user: { role: string } }>("/api/auth/register", {
        method: "POST",
        body: reg,
      });
      // امنیت: نشست فقط با کوکی HttpOnly برقرار می‌شود (بدون توکن در JS/localStorage)
      if (await loadMe()) {
        toast({
          title: "ثبت‌نام موفق 🎉",
          description:
            res.user.role === "ADMIN"
              ? "شما به عنوان مدیر برنامه ثبت شدید"
              : "حساب شما ساخته شد؛ در انتظار تعیین دسترسی توسط مدیر",
        });
      } else {
        toast({
          title: "ثبت‌نام انجام شد اما نشست برقرار نشد",
          description: "مرورگر اجازه ذخیره کوکی در این بستر نمی‌دهد — برنامه را در تب جدید باز کنید",
          variant: "destructive",
        });
      }
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === "OWNER_KEY_REQUIRED") setShowOwnerKey(true);
      if (err.code === "SETUP_TOKEN_REQUIRED") setShowSetupToken(true);
      toast({ title: "ثبت‌نام ناموفق", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const loadMe = async (): Promise<boolean> => {
    try {
      const me = await api<{
        user: { id: string; mobile: string; name: string; company: string | null; role: string };
        sections: string[];
        grantExpiresAt: string | null;
        isAdmin: boolean;
        isOwner?: boolean;
      }>("/api/auth/me");
      // C1/H4: DB محلی per-حساب — پیش از ورود به اپ آماده می‌شود تا صف
      // سفارش‌های همگام‌نشدهِ «همین حساب» (در صورت وجود) بازگردد؛ حساب‌های
      // دیگر هرگز به DB این حساب دسترسی ندارند
      await initLocalDbForUser(me.user.id);
      setMe({
        id: me.user.id,
        mobile: me.user.mobile,
        name: me.user.name,
        company: me.user.company,
        role: me.user.role,
        sections: me.sections,
        grantExpiresAt: me.grantExpiresAt,
        isAdmin: me.isAdmin,
        isOwner: !!me.isOwner,
      });
      return true;
    } catch {
      // نشست نامعتبر — کاربر به صفحه ورود برمی‌گردد
      return false;
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-accent/70 via-background to-background p-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-6">
          <div className="w-24 h-24 rounded-[1.75rem] bg-secondary/60 border border-border flex items-center justify-center overflow-hidden shadow-sm mb-4">
            <Logo size={80} priority />
          </div>
          <h1 className="text-2xl font-black tracking-tight">ویزیتو</h1>
          <div className="brand-word text-[10px] text-primary mt-1.5">VIZITO</div>
          <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
            <Sparkles className="w-3 h-3" />
            ویزیت حرفه‌ای محصولات آرایشی و بهداشتی
          </p>
        </div>

        <Card className="shadow-lg border-border/60">
          <Tabs value={tab} onValueChange={setTab} dir="rtl">
            <CardHeader className="pb-2">
              <TabsList className="grid grid-cols-2 w-full">
                <TabsTrigger value="login">ورود</TabsTrigger>
                <TabsTrigger value="register">ثبت‌نام</TabsTrigger>
              </TabsList>
            </CardHeader>
            <CardContent>
              <TabsContent value="login" className="space-y-4 mt-2">
                <CardDescription className="text-center">
                  با شماره موبایل و رمز عبور وارد شوید
                </CardDescription>
                <div className="space-y-1.5">
                  <Label htmlFor="login-mobile">شماره موبایل</Label>
                  <div className="relative">
                    <User className="absolute right-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="login-mobile"
                      inputMode="numeric"
                      placeholder="09xxxxxxxxx"
                      className="pr-9"
                      value={login.mobile}
                      onChange={(e) => setLogin({ ...login, mobile: e.target.value })}
                      onKeyDown={(e) => e.key === "Enter" && doLogin()}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="login-pass">رمز عبور</Label>
                  <div className="relative">
                    <Lock className="absolute right-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="login-pass"
                      type={showLoginPass ? "text" : "password"}
                      placeholder="••••••"
                      className="pr-9 pl-10"
                      value={login.password}
                      onChange={(e) => setLogin({ ...login, password: e.target.value })}
                      onKeyDown={(e) => e.key === "Enter" && doLogin()}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute left-1 top-1 h-7 w-7 text-muted-foreground hover:text-foreground"
                      onClick={() => setShowLoginPass((v) => !v)}
                      aria-label={showLoginPass ? "مخفی کردن رمز" : "نمایش رمز"}
                    >
                      {showLoginPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
                <Button className="w-full" onClick={doLogin} disabled={loading}>
                  {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                  ورود به ویزیتو
                </Button>
              </TabsContent>

              <TabsContent value="register" className="space-y-4 mt-2">
                {needsSetup && (
                  <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 space-y-1">
                    <div className="text-xs font-bold text-primary flex items-center gap-1.5">
                      <Rocket className="h-3.5 w-3.5" />
                      راه‌اندازی اولیه برنامه
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-5">
                      در حال حاضر هیچ حسابی در برنامه وجود ندارد. اولین ثبت‌نام فقط با «کد راه‌اندازی اولیه»
                      (SETUP_TOKEN روی سرور) ممکن است و آن کاربر مدیر کل برنامه خواهد شد؛
                      پس از آن ثبت‌نام برای همه آزاد است (کد دعوت فقط اختیاری است).
                    </p>
                  </div>
                )}
                <CardDescription className="text-center">
                  ثبت‌نام آزاد است — پس از ثبت‌نام، ۲۴ ساعت استفاده رایگان دارید
                </CardDescription>
                {(needsSetup || showSetupToken) && (
                  <div className="space-y-1.5">
                    <Label htmlFor="reg-setuptoken">کد راه‌اندازی اولیه</Label>
                    <Input
                      id="reg-setuptoken"
                      type="password"
                      placeholder="SETUP_TOKEN"
                      className="font-mono"
                      dir="ltr"
                      value={reg.setupToken}
                      onChange={(e) => setReg({ ...reg, setupToken: e.target.value })}
                    />
                    <p className="text-[10px] text-muted-foreground">
                      برای اولین ثبت‌نام (مدیر شدن) روی هر سرور الزامی است — روی سرور در env: SETUP_TOKEN تنظیم می‌شود
                    </p>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="reg-mobile">شماره موبایل</Label>
                  <Input
                    id="reg-mobile"
                    inputMode="numeric"
                    placeholder="09xxxxxxxxx"
                    value={reg.mobile}
                    onChange={(e) => setReg({ ...reg, mobile: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reg-name">نام / شرکت</Label>
                  <Input
                    id="reg-name"
                    placeholder="مثلاً شرکت زیبایی آرتا"
                    value={reg.name}
                    onChange={(e) => setReg({ ...reg, name: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reg-company">نام برند (اختیاری)</Label>
                  <div className="relative">
                    <Building2 className="absolute right-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="reg-company"
                      placeholder="مثلاً VIZITO"
                      className="pr-9"
                      value={reg.company}
                      onChange={(e) => setReg({ ...reg, company: e.target.value })}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reg-invite">کد دعوت (اختیاری)</Label>
                  <div className="relative">
                    <KeyRound className="absolute right-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="reg-invite"
                      placeholder="مثلاً K7MP2XAB — مدیر در تنظیمات می‌بیند"
                      className="pr-9"
                      dir="ltr"
                      value={reg.inviteCode}
                      onChange={(e) => setReg({ ...reg, inviteCode: e.target.value })}
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    اختیاری است — اگر از مدیر کد دعوت دارید وارد کنید؛ خالی بودن این فیلد مانع ثبت‌نام نیست
                  </p>
                </div>
                {showOwnerKey && (
                  <div className="space-y-1.5">
                    <Label htmlFor="reg-setup">کلید راه‌اندازی سازنده</Label>
                    <Input
                      id="reg-setup"
                      type="password"
                      placeholder="OWNER_SETUP_KEY"
                      className="font-mono"
                      dir="ltr"
                      value={reg.setupKey}
                      onChange={(e) => setReg({ ...reg, setupKey: e.target.value })}
                    />
                    <p className="text-[10px] text-muted-foreground">
                      این شماره به حساب سازنده نیاز دارد — کلید باید با env: OWNER_SETUP_KEY روی سرور یکسان باشد (بدون نیاز به کد دعوت)
                    </p>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="reg-pass">رمز عبور</Label>
                  <div className="relative">
                    <Lock className="absolute right-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="reg-pass"
                      type={showRegPass ? "text" : "password"}
                      placeholder="••••••"
                      className="pr-9 pl-10"
                      value={reg.password}
                      onChange={(e) => setReg({ ...reg, password: e.target.value })}
                      onKeyDown={(e) => e.key === "Enter" && doRegister()}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute left-1 top-1 h-7 w-7 text-muted-foreground hover:text-foreground"
                      onClick={() => setShowRegPass((v) => !v)}
                      aria-label={showRegPass ? "مخفی کردن رمز" : "نمایش رمز"}
                    >
                      {showRegPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
                <Button className="w-full" onClick={doRegister} disabled={loading}>
                  {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                  ثبت‌نام
                </Button>
              </TabsContent>
            </CardContent>
          </Tabs>
        </Card>

        <p className="text-center text-[11px] text-muted-foreground mt-6">
          VIZITO © — تقویم هجری شمسی • دارک مود • خروجی PDF در پوشه «ویزیتو»
        </p>
      </div>
    </div>
  );
}
