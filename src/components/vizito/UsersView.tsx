"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { SECTIONS, PERMISSION_EXTRAS, sectionLabel, type SectionKey } from "@/lib/sections";
import { DURATION_PRESETS, expiryLabel, formatJalali, toFa } from "@/lib/jalali";
import type { AppUser } from "@/lib/types";
import { toast } from "@/hooks/use-toast";
import { useApp } from "@/lib/store";
import {
  UserCog,
  UserPlus,
  Crown,
  Trash2,
  KeyRound,
  ShieldCheck,
  ShieldOff,
  Loader2,
  Lock,
  MessageSquarePlus,
  MessageSquare,
  Send,
  Eye,
  EyeOff,
  Power,
  PowerOff,
} from "lucide-react";

/** همه گزینه‌های دسترسی: بخش‌های اصلی (بدون مدیریت کاربران) + دسترسی‌های ویژه */
const GRANTABLE = [
  ...SECTIONS.filter((s) => s.key !== "users").map((s) => ({ key: s.key as string, label: s.label, extra: false })),
  ...PERMISSION_EXTRAS.map((s) => ({ key: s.key as string, label: s.label, extra: true })),
];

function PermissionChecklist({
  selected,
  onToggle,
}: {
  selected: string[];
  onToggle: (key: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      {GRANTABLE.map((s) => (
        <label
          key={s.key}
          className="flex items-center gap-2 text-sm cursor-pointer rounded-lg border p-2.5 hover:bg-accent/50"
        >
          <Checkbox checked={selected.includes(s.key)} onCheckedChange={() => onToggle(s.key)} />
          <span className={s.extra ? "flex items-center gap-1 text-[13px] text-amber-700 dark:text-amber-300" : ""}>
            {s.extra && <Lock className="h-3 w-3" />}
            {s.label}
          </span>
        </label>
      ))}
    </div>
  );
}

function DurationSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-bold">مدت اعتبار (از ۱ ساعت تا چند ماه)</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DURATION_PRESETS.map((d) => (
            <SelectItem key={d.label} value={d.hours === null ? "never" : String(d.hours)}>
              {d.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[10px] text-muted-foreground">
        پس از پایان مدت، دسترسی کاربر به صورت خودکار قطع می‌شود و نیاز به تمدید دارد
      </p>
    </div>
  );
}

export function UsersView() {
  const { me } = useApp();
  const [users, setUsers] = useState<AppUser[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [grantUser, setGrantUser] = useState<AppUser | null>(null);
  const [saving, setSaving] = useState(false);

  const [createForm, setCreateForm] = useState({ mobile: "", name: "", company: "", password: "" });
  const [createSections, setCreateSections] = useState<string[]>([]);
  const [createDuration, setCreateDuration] = useState("720");

  const [grantSections, setGrantSections] = useState<string[]>([]);
  const [duration, setDuration] = useState("720");

  // ارسال یادداشت به کاربران (۱۱-۵)
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteTarget, setNoteTarget] = useState("ALL");
  const [noteTitle, setNoteTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<AppUser[]>("/api/users");
      setUsers(data);
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
      setUsers([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleCreateSection = (key: string) => {
    setCreateSections((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };
  const toggleGrantSection = (key: string) => {
    setGrantSections((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const createUser = async () => {
    if (!createForm.mobile.trim() || !createForm.name.trim() || createForm.password.length < 8) {
      toast({
        title: "خطا",
        description: "موبایل، نام و رمز عبور (حداقل ۸ کاراکتر) را کامل کنید",
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    try {
      const preset = DURATION_PRESETS.find((d) => String(d.hours) === createDuration || (d.hours === null && createDuration === "never"));
      await api("/api/users", {
        method: "POST",
        body: {
          ...createForm,
          sections: createSections,
          durationHours: preset ? preset.hours : 720,
        },
      });
      toast({
        title: "کاربر ساخته شد ✅",
        description: createSections.length
          ? `دسترسی زمان‌دار (${preset?.label}) برای ${createSections.length} بخش ثبت شد`
          : "برای تعیین دسترسی از دکمه «تعیین دسترسی» استفاده کنید",
      });
      setCreateOpen(false);
      setCreateForm({ mobile: "", name: "", company: "", password: "" });
      setCreateSections([]);
      setCreateDuration("720");
      load();
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const openGrant = (u: AppUser) => {
    setGrantUser(u);
    const now = Date.now();
    // گرنت دائمی (expiresAt = null) همیشه فعال است
    const active = u.grants.find((g) => g.expiresAt === null || new Date(g.expiresAt).getTime() > now);
    setGrantSections(active ? JSON.parse(active.sections) : []);
    setDuration(active?.expiresAt === null ? "never" : "720");
  };

  // تغییر رمز عبور کاربر توسط مدیر (۱۲-۱)
  const [pwUser, setPwUser] = useState<AppUser | null>(null);
  const [pwValue, setPwValue] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [pwSaving, setPwSaving] = useState(false);

  const openPassword = (u: AppUser) => {
    setPwUser(u);
    setPwValue("");
    setShowPw(false);
  };

  const savePassword = async () => {
    if (!pwUser) return;
    if (pwValue.length < 8) {
      toast({ title: "خطا", description: "رمز عبور باید حداقل ۸ کاراکتر باشد", variant: "destructive" });
      return;
    }
    setPwSaving(true);
    try {
      await api(`/api/users/${pwUser.id}`, { method: "PUT", body: { password: pwValue } });
      toast({ title: "رمز کاربر تغییر کرد ✅", description: `${pwUser.name} باید با رمز جدید وارد شود` });
      setPwUser(null);
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setPwSaving(false);
    }
  };

  const saveGrant = async () => {
    if (!grantUser) return;
    if (grantSections.length === 0) {
      toast({ title: "خطا", description: "حداقل یک بخش را انتخاب کنید", variant: "destructive" });
      return;
    }
    const preset = DURATION_PRESETS.find((d) => String(d.hours) === duration || (d.hours === null && duration === "never"));
    const hours = preset?.hours;
    if (hours === undefined) return;
    // اعتبار دائمی واقعی — بدون تاریخ انقضا (سقف ۵/۱۰ ساله حذف شد)
    const expiresAt = hours === null ? null : new Date(Date.now() + hours * 3600000).toISOString();
    setSaving(true);
    try {
      await api(`/api/users/${grantUser.id}/grant`, {
        method: "POST",
        body: { sections: grantSections, expiresAt },
      });
      toast({ title: "دسترسی ثبت شد ✅", description: `${grantUser.name} — ${preset?.label}` });
      setGrantUser(null);
      load();
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  // فعال/غیرفعال‌سازی مستقل حساب — بدون حذف اطلاعات؛ نشست‌ها سمت سرور ابطال می‌شود
  const toggleDisabled = async (u: AppUser) => {
    const action = !u.disabled;
    if (
      action &&
      !confirm(
        `حساب «${u.name}» غیرفعال شود؟\nکاربر نمی‌تواند وارد شود و نشست‌های فعالش باطل می‌شود؛ اطلاعات او حفظ می‌ماند.`
      )
    )
      return;
    try {
      await api(`/api/users/${u.id}`, { method: "PUT", body: { disabled: action } });
      toast({
        title: action ? "حساب غیرفعال شد ✅" : "حساب فعال شد ✅",
        description: action ? `${u.name} دیگر نمی‌تواند وارد شود` : `${u.name} می‌تواند وارد شود`,
      });
      load();
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    }
  };

  const removeUser = async (u: AppUser) => {
    if (!confirm(`کاربر «${u.name}» حذف شود؟`)) return;
    try {
      await api(`/api/users/${u.id}`, { method: "DELETE" });
      toast({ title: "کاربر حذف شد" });
      load();
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    }
  };

  // ---- ارسال یادداشت (۱۱-۵) ----
  const openNoteDialog = (u?: AppUser) => {
    setNoteTarget(u ? u.id : "ALL");
    setNoteTitle("");
    setNoteBody("");
    setNoteOpen(true);
  };

  const sendNote = async () => {
    if (!noteTitle.trim()) {
      toast({ title: "خطا", description: "عنوان پیام الزامی است", variant: "destructive" });
      return;
    }
    setNoteSaving(true);
    try {
      const res = await api<{ ok: boolean; count: number }>("/api/notifications", {
        method: "PUT",
        body: { target: noteTarget, title: noteTitle.trim(), body: noteBody.trim() },
      });
      toast({ title: `یادداشت ارسال شد ✅ (${toFa(res.count)} کاربر)` });
      setNoteOpen(false);
      setNoteTitle("");
      setNoteBody("");
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setNoteSaving(false);
    }
  };

  const activeGrant = (u: AppUser) => {
    const now = Date.now();
    // گرنت دائمی (expiresAt = null) همیشه فعال است
    const valid = u.grants.filter((g) => g.expiresAt === null || new Date(g.expiresAt).getTime() > now);
    return valid[0] || null;
  };

  return (
    <div className="space-y-3 app-fade">
      <div className="flex items-center justify-between gap-2">
        <h1 className="font-bold text-lg flex items-center gap-2">
          <UserCog className="h-5 w-5 text-primary" /> مدیریت کاربران
        </h1>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <UserPlus className="h-4 w-4" /> کاربر جدید
        </Button>
      </div>

      {/* ارسال یادداشت/پیام به کاربران (۱۱-۵) */}
      <Button variant="secondary" size="sm" className="w-full justify-start" onClick={() => openNoteDialog()}>
        <MessageSquarePlus className="h-4 w-4" /> ارسال یادداشت به کاربران
      </Button>

      {!users ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : (
        <div className="space-y-2">
          {users.map((u) => {
            const grant = activeGrant(u);
            const sections: string[] = grant ? JSON.parse(grant.sections) : [];
            return (
              <Card key={u.id}>
                <CardContent className="p-3 space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-sm">{u.name}</span>
                        {u.role === "ADMIN" ? (
                          <Badge className="text-[9px] gap-1 bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-0">
                            <Crown className="h-2.5 w-2.5" /> مدیر کل
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[9px]">کاربر</Badge>
                        )}
                        {u.disabled && (
                          <Badge variant="destructive" className="text-[9px] gap-1">
                            <PowerOff className="h-2.5 w-2.5" /> غیرفعال
                          </Badge>
                        )}
                        {u.id === me?.id && (
                          <Badge variant="outline" className="text-[9px]">شما</Badge>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-0.5" dir="ltr">
                        {toFa(u.mobile)} {u.company ? `• ${u.company}` : ""}
                      </div>
                    </div>
                    {u.id !== me?.id && (
                      <div className="flex gap-1 shrink-0">
                        {u.role !== "ADMIN" && (
                          <>
                            <Button size="sm" variant="secondary" className="h-7 text-[11px]" onClick={() => openGrant(u)}>
                              <KeyRound className="h-3 w-3" /> {grant ? "تمدید دسترسی" : "تعیین دسترسی"}
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className={`h-7 w-7 ${u.disabled ? "text-emerald-600" : "text-destructive"}`}
                              onClick={() => void toggleDisabled(u)}
                              aria-label={u.disabled ? "فعال‌سازی حساب" : "غیرفعال‌سازی حساب"}
                            >
                              {u.disabled ? <Power className="h-3.5 w-3.5" /> : <PowerOff className="h-3.5 w-3.5" />}
                            </Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-primary" onClick={() => openNoteDialog(u)} aria-label="ارسال یادداشت">
                              <MessageSquare className="h-3.5 w-3.5" />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => removeUser(u)} aria-label="حذف کاربر">
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        )}
                        <Button size="icon" variant="ghost" className="h-7 w-7 text-primary" onClick={() => openPassword(u)} aria-label="تغییر رمز عبور کاربر">
                          <Lock className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </div>

                  {u.role !== "ADMIN" && (
                    <>
                      <Separator className="my-1" />
                      {grant ? (
                        <div className="flex items-start gap-1.5 text-[11px]">
                          <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 mt-0.5 shrink-0" />
                          <div>
                            <div className="font-medium">
                              {grant.expiresAt === null
                                ? "اعتبار دائمی — بدون تاریخ انقضا"
                                : `${expiryLabel(grant.expiresAt)} (${formatJalali(grant.expiresAt)})`}
                            </div>
                            <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-1">
                              {sections.map((s) => (
                                <Badge key={s} variant="secondary" className="text-[9px]">
                                  {sectionLabel(s)}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        </div>
                      ) : u.disabled ? (
                        <div className="flex items-center gap-1.5 text-[11px] text-destructive">
                          <PowerOff className="h-3.5 w-3.5 shrink-0" />
                          حساب غیرفعال است — کاربر نمی‌تواند وارد شود (اطلاعاتش حفظ شده است)
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <ShieldOff className="h-3.5 w-3.5 text-destructive" />
                          بدون دسترسی فعال — برای استفاده باید دسترسی زمان‌دار تعیین شود
                        </div>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* دیالوگ ساخت کاربر — همراه مدت و دسترسی */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[88dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>تعریف کاربر جدید</DialogTitle>
            <DialogDescription>
              مشخصات کاربر، مدت اعتبار دسترسی (از ۱ ساعت تا چند ماه) و بخش‌های مجاز را تعیین کنید
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label>شماره موبایل *</Label>
                <Input inputMode="numeric" placeholder="09xxxxxxxxx" value={createForm.mobile} onChange={(e) => setCreateForm({ ...createForm, mobile: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>نام *</Label>
                <Input placeholder="نام کاربر" value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>شرکت</Label>
              <Input placeholder="اختیاری" value={createForm.company} onChange={(e) => setCreateForm({ ...createForm, company: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>رمز عبور *</Label>
              <Input type="password" placeholder="حداقل ۸ کاراکتر" value={createForm.password} onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })} />
            </div>

            <Separator />

            <div className="space-y-2">
              <Label className="text-xs font-bold">بخش‌های مجاز</Label>
              <PermissionChecklist selected={createSections} onToggle={toggleCreateSection} />
              <p className="text-[10px] text-muted-foreground">
                اگر چیزی انتخاب نکنید، کاربر ساخته می‌شود ولی تا تعیین دسترسی وارد برنامه نمی‌تواند شود
              </p>
            </div>

            <DurationSelect value={createDuration} onChange={setCreateDuration} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>انصراف</Button>
            <Button onClick={createUser} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} ساخت کاربر
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* دیالوگ تعیین/تمدید دسترسی */}
      <Dialog open={!!grantUser} onOpenChange={(v) => !v && setGrantUser(null)}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>دسترسی زمان‌دار — {grantUser?.name}</DialogTitle>
            <DialogDescription>
              بخش‌های قابل استفاده و مدت اعتبار (از یک ساعت تا چند ماه) را تعیین کنید
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label className="text-xs font-bold">بخش‌های مجاز</Label>
              <PermissionChecklist selected={grantSections} onToggle={toggleGrantSection} />
            </div>
            <DurationSelect value={duration} onChange={setDuration} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGrantUser(null)}>انصراف</Button>
            <Button onClick={saveGrant} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} ثبت دسترسی
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* دیالوگ تغییر رمز عبور کاربر توسط مدیر (۱۲-۱) */}
      <Dialog open={!!pwUser} onOpenChange={(v) => !v && setPwUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>تغییر رمز عبور — {pwUser?.name}</DialogTitle>
            <DialogDescription>
              رمز جدید را تعیین کنید؛ نشست‌های فعال این کاربر باطل می‌شود تا با رمز جدید وارد شود
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>رمز عبور جدید (حداقل ۸ کاراکتر)</Label>
            <div className="relative">
              <Input
                type={showPw ? "text" : "password"}
                dir="ltr"
                value={pwValue}
                onChange={(e) => setPwValue(e.target.value)}
                className="h-9 pl-9"
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? "مخفی کردن رمز" : "نمایش رمز"}
                className="absolute left-1 top-1/2 -translate-y-1/2 h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
              >
                {showPw ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPwUser(null)} disabled={pwSaving}>انصراف</Button>
            <Button onClick={savePassword} disabled={pwSaving}>
              {pwSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />} ذخیره رمز جدید
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* دیالوگ ارسال یادداشت به کاربران (۱۱-۵) */}
      <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ارسال یادداشت به کاربران</DialogTitle>
            <DialogDescription>
              پیام شما در اعلان‌های کاربر (زنگ اعلان) نمایش داده می‌شود
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>گیرنده *</Label>
              <Select value={noteTarget} onValueChange={setNoteTarget}>
                <SelectTrigger>
                  <SelectValue placeholder="انتخاب گیرنده" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">همه کاربران</SelectItem>
                  {(users || [])
                    .filter((u) => u.role !== "ADMIN")
                    .map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>عنوان *</Label>
              <Input
                value={noteTitle}
                onChange={(e) => setNoteTitle(e.target.value)}
                placeholder="مثلاً بروزرسانی کاتالوگ"
              />
            </div>
            <div className="space-y-1.5">
              <Label>متن پیام</Label>
              <Textarea
                rows={3}
                value={noteBody}
                onChange={(e) => setNoteBody(e.target.value)}
                placeholder="متن یادداشت (اختیاری)"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNoteOpen(false)} disabled={noteSaving}>
              انصراف
            </Button>
            <Button onClick={sendNote} disabled={noteSaving}>
              {noteSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} ارسال
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
