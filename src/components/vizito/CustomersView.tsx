"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
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
import { useApp } from "@/lib/store";
import { api } from "@/lib/api";
import { formatJalali, toFa } from "@/lib/jalali";
import { CUSTOMER_TYPES } from "@/lib/sections";
import type { Customer } from "@/lib/types";
import { readSnapshot, mirror } from "@/lib/offline";
import { toast } from "@/hooks/use-toast";
import {
  Search,
  Plus,
  Phone,
  MapPin,
  IdCard,
  Store,
  Pill,
  Scissors,
  Pencil,
  Trash2,
  ChevronLeft,
  Building2,
  Users,
  Archive,
  ArchiveRestore,
  CloudOff,
} from "lucide-react";

const emptyForm = {
  name: "",
  company: "",
  phone: "",
  address: "",
  nationalId: "",
  type: "STORE",
};

export function CustomersView() {
  const { setView, me, online } = useApp();
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [query, setQuery] = useState("");
  // ممیزی v1.0.9 — نمایش فعال/آرشیو: حذف مشتریِ دارای سابقه = آرشیو (نه حذف)
  const [showArchived, setShowArchived] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (q = "", archived = false) => {
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (archived) params.set("archived", "1");
      const qs = params.toString();
      const data = await api<Customer[]>(`/api/customers${qs ? `?${qs}` : ""}`);
      setCustomers(data);
      // آینه‌سازی برای حالت آفلاین — فقط فهرست بدون فیلتر (منبع سفارش‌گیری آفلاین)
      if (!q && !archived) void mirror("customers", data);
    } catch {
      // قطعی — اسنپ‌شات آخرین همگام‌سازی (فقط خواندن)
      const snap = await readSnapshot<Customer[]>("customers");
      if (snap) {
        setCustomers(snap.value);
        return;
      }
      toast({
        title: "حالت آفلاین",
        description: "هیچ داده همگام‌سازی‌شده‌ای روی این دستگاه نیست — پس از اتصال دوباره تلاش کنید",
        variant: "destructive",
      });
      setCustomers([]);
    }
  }, []);

  useEffect(() => {
    load(query, showArchived);
  }, [query, showArchived, load]);

  const openCreate = () => {
    // قفل آفلاین (بخش ۵.۲ سند): ثبت/ویرایش مشتری ممنوع — سرور هم مستقل رد می‌کند
    if (!online) {
      toast({ title: "حالت آفلاین", description: "در حالت آفلاین ثبت/ویرایش مشتری ممکن نیست", variant: "destructive" });
      return;
    }
    setEditing(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (c: Customer) => {
    if (!online) {
      toast({ title: "حالت آفلاین", description: "در حالت آفلاین ثبت/ویرایش مشتری ممکن نیست", variant: "destructive" });
      return;
    }
    setEditing(c);
    setForm({
      name: c.name,
      company: c.company || "",
      phone: c.phone,
      address: c.address || "",
      nationalId: c.nationalId || "",
      type: c.type,
    });
    setDialogOpen(true);
  };

  const save = async () => {
    if (!form.name.trim() || !form.phone.trim()) {
      toast({ title: "خطا", description: "نام و تلفن مشتری الزامی است", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await api(`/api/customers/${editing.id}`, { method: "PUT", body: form });
        toast({ title: "ویرایش شد ✅", description: "مشتری با موفقیت ویرایش شد" });
      } else {
        await api("/api/customers", { method: "POST", body: form });
        toast({ title: "ثبت شد ✅", description: "پروفایل مشتری ساخته شد" });
      }
      setDialogOpen(false);
      load(query, showArchived);
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: Customer) => {
    if (!online) {
      toast({ title: "حالت آفلاین", description: "در حالت آفلاین حذف/آرشیو مشتری ممکن نیست", variant: "destructive" });
      return;
    }
    // ممیزی v1.0.9 — مشتریِ دارای سفارش/پرداخت هرگز سخت‌حذف نمی‌شود؛ سرور او را آرشیو می‌کند
    if (showArchived) {
      if (!confirm(`حذف دائمی «${c.name}»؟ فقط اگر هیچ سفارش و پرداختی نداشته باشد حذف می‌شود؛ در غیر این صورت در آرشیو می‌ماند.`)) return;
    } else {
      if (!confirm(`مشتری «${c.name}» حذف شود؟\nاگر سفارش یا پرداخت داشته باشد، حذف دائمی نمی‌شود و فقط آرشیو می‌شود (سوابق مالی حفظ می‌ماند).`)) return;
    }
    try {
      const r = await api<{ ok: boolean; archived?: boolean }>(`/api/customers/${c.id}`, { method: "DELETE" });
      if (r?.archived) {
        toast({
          title: "به آرشیو منتقل شد 📦",
          description: "این مشتری سابقه سفارش/پرداخت دارد — سوابق مالی حفظ شد و می‌توانید او را بازگردانید",
        });
      } else {
        toast({ title: "حذف شد" });
      }
      load(query, showArchived);
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    }
  };

  const unarchive = async (c: Customer) => {
    if (!online) {
      toast({ title: "حالت آفلاین", description: "در حالت آفلاین بازگردانی مشتری ممکن نیست", variant: "destructive" });
      return;
    }
    try {
      await api(`/api/customers/${c.id}`, { method: "PATCH", body: { archived: false } });
      toast({ title: "بازگردانی شد ✅", description: "مشتری به فهرست فعالان برگشت" });
      load(query, showArchived);
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    }
  };

  const openProfile = (c: Customer) => {
    setView("customer-profile", { customerId: c.id });
  };

  const typeIcon = (t: string) =>
    t === "PHARMACY" ? <Pill className="h-3.5 w-3.5" /> : t === "SALON" ? <Scissors className="h-3.5 w-3.5" /> : <Store className="h-3.5 w-3.5" />;
  const typeLabel = (t: string) => CUSTOMER_TYPES.find((x) => x.key === t)?.label || t;

  // راهنمای محدوده دسترسی مشتری‌ها
  const scopeHint = me?.isAdmin
    ? "شما مدیر هستید و به همه مشتری‌ها دسترسی دارید"
    : me?.sections?.includes("all_customers")
      ? "دسترسی به تمام مشتری‌ها — همه مشتری‌ها را می‌بینید"
      : "هر مشتری که ثبت کنید فقط برای شما و مدیر قابل مشاهده است";

  return (
    <div className="space-y-3 app-fade">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="font-bold text-lg">مشتریان</h1>
          <p className="text-[10px] text-muted-foreground mt-0.5">{scopeHint}</p>
        </div>
        <Button size="sm" onClick={openCreate} aria-disabled={!online}>
          <Plus className="h-4 w-4" /> مشتری جدید
        </Button>
      </div>

      {/* اطلاع فقط‌خواندنی آفلاین — بخش ۵.۲ سند */}
      {!online && (
        <div
          role="status"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px] text-amber-800 dark:text-amber-300 flex items-center gap-2"
        >
          <CloudOff className="h-4 w-4 shrink-0" />
          <span>
            نمایش از آخرین همگام‌سازی دستگاه — ثبت/ویرایش/حذف مشتری در حالت آفلاین ممکن نیست؛ سفارش‌گیری از همین فهرست آزاد است.
          </span>
        </div>
      )}

      <div className="relative">
        <Search className="absolute right-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="جستجو: نام، شرکت، تلفن، کد ملی..."
          className="pr-9"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {/* فیلتر فعال/آرشیو — ممیزی v1.0.9 */}
      <div className="flex items-center gap-1.5" role="tablist" aria-label="وضعیت مشتریان">
        <Button
          size="sm"
          variant={showArchived ? "outline" : "secondary"}
          onClick={() => setShowArchived(false)}
          aria-selected={!showArchived}
          role="tab"
        >
          <Users className="h-3.5 w-3.5" /> فعال
        </Button>
        <Button
          size="sm"
          variant={showArchived ? "secondary" : "outline"}
          onClick={() => setShowArchived(true)}
          aria-selected={showArchived}
          role="tab"
        >
          <Archive className="h-3.5 w-3.5" /> آرشیو
        </Button>
      </div>

      {!customers ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ) : customers.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center space-y-2">
            {showArchived ? (
              <>
                <Archive className="h-10 w-10 text-muted-foreground/40 mx-auto" />
                <p className="text-sm text-muted-foreground">آرشیو خالی است</p>
                <p className="text-[11px] text-muted-foreground/70">
                  مشتری‌های حذف‌شده‌ای که سابقه سفارش/پرداخت دارند اینجا نگه‌داری می‌شوند
                </p>
              </>
            ) : (
              <>
                <Users className="h-10 w-10 text-muted-foreground/40 mx-auto" />
                <p className="text-sm text-muted-foreground">هنوز مشتری ثبت نشده است</p>
                <Button size="sm" variant="secondary" onClick={openCreate}>
                  <Plus className="h-4 w-4" /> ثبت اولین مشتری
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {customers.map((c) => (
            <Card key={c.id} className="hover:border-primary/40 transition-colors">
              <CardContent className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <button className="text-right flex-1 min-w-0" onClick={() => openProfile(c)}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-sm">{c.name}</span>
                      <Badge variant="secondary" className="text-[9px] gap-1">
                        {typeIcon(c.type)}
                        {typeLabel(c.type)}
                      </Badge>
                      {c.archived && (
                        <Badge variant="outline" className="text-[9px] gap-1 text-muted-foreground">
                          <Archive className="h-3 w-3" /> آرشیو
                        </Badge>
                      )}
                    </div>
                    {c.company && (
                      <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1">
                        <Building2 className="h-3 w-3" /> {c.company}
                      </div>
                    )}
                    <div className="text-[11px] text-muted-foreground mt-1 space-y-0.5">
                      <div className="flex items-center gap-1" dir="ltr">
                        <Phone className="h-3 w-3" /> {toFa(c.phone)}
                      </div>
                      {c.address && (
                        <div className="flex items-center gap-1 truncate">
                          <MapPin className="h-3 w-3 shrink-0" /> <span className="truncate">{c.address}</span>
                        </div>
                      )}
                      {c.nationalId && (
                        <div className="flex items-center gap-1">
                          <IdCard className="h-3 w-3" /> کد ملی: {toFa(c.nationalId)}
                        </div>
                      )}
                    </div>
                  </button>
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <div className="flex items-center gap-0.5">
                      {showArchived ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-primary"
                          onClick={() => unarchive(c)}
                          aria-label="بازگردانی از آرشیو"
                        >
                          <ArchiveRestore className="h-3.5 w-3.5" />
                        </Button>
                      ) : (
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(c)} aria-label="ویرایش">
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => remove(c)} aria-label={showArchived ? "حذف دائمی" : "حذف"}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <button
                      onClick={() => openProfile(c)}
                      className="text-[10px] text-primary flex items-center gap-0.5 font-medium"
                    >
                      {toFa(c._count?.orders ?? 0)} سفارش
                      <ChevronLeft className="h-3 w-3" />
                    </button>
                  </div>
                </div>
                <div className="text-[9px] text-muted-foreground mt-1">
                  عضویت: {formatJalali(c.createdAt)}
                  {c.archived && c.archivedAt ? ` • آرشیو: ${formatJalali(c.archivedAt)}` : ""}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* دیالوگ ثبت/ویرایش */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "ویرایش مشتری" : "مشتری جدید"}</DialogTitle>
            <DialogDescription>
              اطلاعات پروفایل مشتری شامل نام/شرکت، تلفن، آدرس و کد ملی
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>نام / شرکت *</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="مثلاً داروخانه دکتر رضایی" />
            </div>
            <div className="space-y-1.5">
              <Label>تلفن *</Label>
              <Input inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="09xxxxxxxxx" />
            </div>
            <div className="space-y-1.5">
              <Label>نوع مشتری</Label>
              <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CUSTOMER_TYPES.map((t) => (
                    <SelectItem key={t.key} value={t.key}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>کد ملی</Label>
              <Input inputMode="numeric" value={form.nationalId} onChange={(e) => setForm({ ...form, nationalId: e.target.value })} placeholder="اختیاری" />
            </div>
            <div className="space-y-1.5">
              <Label>آدرس</Label>
              <Textarea rows={2} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="اختیاری" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              انصراف
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "در حال ذخیره..." : "ذخیره"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
