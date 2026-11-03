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
  const { setView, me } = useApp();
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [query, setQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (q = "") => {
    try {
      const data = await api<Customer[]>(`/api/customers${q ? `?q=${encodeURIComponent(q)}` : ""}`);
      setCustomers(data);
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
      setCustomers([]);
    }
  }, []);

  useEffect(() => {
    load(query);
  }, [query, load]);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (c: Customer) => {
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
      load(query);
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: Customer) => {
    if (!confirm(`مشتری «${c.name}» و همه سفارش‌هایش حذف شود؟`)) return;
    try {
      await api(`/api/customers/${c.id}`, { method: "DELETE" });
      toast({ title: "حذف شد" });
      load(query);
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
        <Button size="sm" onClick={openCreate}>
          <Plus className="h-4 w-4" /> مشتری جدید
        </Button>
      </div>

      <div className="relative">
        <Search className="absolute right-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="جستجو: نام، شرکت، تلفن، کد ملی..."
          className="pr-9"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
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
            <Users className="h-10 w-10 text-muted-foreground/40 mx-auto" />
            <p className="text-sm text-muted-foreground">هنوز مشتری ثبت نشده است</p>
            <Button size="sm" variant="secondary" onClick={openCreate}>
              <Plus className="h-4 w-4" /> ثبت اولین مشتری
            </Button>
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
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(c)} aria-label="ویرایش">
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => remove(c)} aria-label="حذف">
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
                <div className="text-[9px] text-muted-foreground mt-1">عضویت: {formatJalali(c.createdAt)}</div>
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
