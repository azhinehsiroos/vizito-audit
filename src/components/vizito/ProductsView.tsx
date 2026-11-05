"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useApp } from "@/lib/store";
import { api } from "@/lib/api";
import { formatMoney, toFa } from "@/lib/jalali";
import { fileToCompressedDataUrl } from "@/lib/image";
import type { Product, ProductGroup } from "@/lib/types";
import { readSnapshot, mirror } from "@/lib/offline";
import { toast } from "@/hooks/use-toast";
import {
  Plus,
  Pencil,
  Trash2,
  FolderOpen,
  FolderPlus,
  Percent,
  Gift,
  Package,
  Camera,
  Loader2,
  Lock,
  CloudOff,
} from "lucide-react";

const emptyProduct = {
  groupId: "",
  name: "",
  image: "" as string,
  description: "",
  volume: "",
  offer: "",
  pricePurchase: "",
  priceStore: "",
  pricePharmacy: "",
  priceSalon: "",
  discount: "",
  minOrder: "1",
};

export function ProductsView() {
  const { setView, can, online } = useApp();
  const canPurchase = can("purchase_price");
  const [groups, setGroups] = useState<ProductGroup[] | null>(null);
  const [groupDialog, setGroupDialog] = useState(false);
  const [editingGroup, setEditingGroup] = useState<ProductGroup | null>(null);
  const [groupName, setGroupName] = useState("");
  const [productDialog, setProductDialog] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [form, setForm] = useState(emptyProduct);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // تایید اعمال تغییرات (۱۱-۴): هیچ تغییری بدون تایید مدیر اعمال نمی‌شود
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ run: () => Promise<void> } | null>(null);

  // قفل آفلاین (بخش ۵.۲ سند): ثبت/ویرایش کالا/گروه/قیمت/تخفیف ممنوع — سرور هم مستقل رد می‌کند
  const requireOnline = (): boolean => {
    if (!online) {
      toast({
        title: "حالت آفلاین",
        description: "در حالت آفلاین ثبت/ویرایش کالا و گروه ممکن نیست",
        variant: "destructive",
      });
      return false;
    }
    return true;
  };

  const requestConfirm = (run: () => Promise<void>) => {
    if (!requireOnline()) return;
    setPendingAction({ run });
    setConfirmOpen(true);
  };

  const runPending = async () => {
    const action = pendingAction;
    setPendingAction(null);
    if (!action) return;
    await action.run();
  };

  const load = useCallback(async () => {
    try {
      const data = await api<ProductGroup[]>("/api/groups");
      setGroups(data);
      // آینه‌سازی برای سفارش‌گیری آفلاین (منبع قیمت‌های منجمد بخش ۵.۳)
      void mirror("groups", data);
    } catch {
      // قطعی — اسنپ‌شات آخرین همگام‌سازی (فقط خواندن)
      const snap = await readSnapshot<ProductGroup[]>("groups");
      if (snap) {
        setGroups(snap.value);
        return;
      }
      toast({
        title: "حالت آفلاین",
        description: "هیچ داده همگام‌سازی‌شده‌ای روی این دستگاه نیست — پس از اتصال دوباره تلاش کنید",
        variant: "destructive",
      });
      setGroups([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ---- گروه‌ها ----
  /** اعتبارسنجی فرم گروه — قبل از نمایش تایید */
  const validateGroupForm = () => {
    if (!groupName.trim()) {
      toast({ title: "خطا", description: "نام گروه را وارد کنید", variant: "destructive" });
      return false;
    }
    return true;
  };

  const saveGroup = async () => {
    if (!validateGroupForm()) return;
    setSaving(true);
    try {
      if (editingGroup) {
        await api(`/api/groups/${editingGroup.id}`, { method: "PUT", body: { name: groupName } });
      } else {
        await api("/api/groups", { method: "POST", body: { name: groupName } });
      }
      toast({ title: "ذخیره شد ✅" });
      setGroupDialog(false);
      setGroupName("");
      setEditingGroup(null);
      load();
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  /** ساخت/ویرایش گروه — ابتدا تایید، سپس اعمال + ارسال اعلان */
  const requestGroupSave = () => {
    if (!validateGroupForm()) return;
    requestConfirm(saveGroup);
  };

  const removeGroup = async (g: ProductGroup) => {
    try {
      await api(`/api/groups/${g.id}`, { method: "DELETE" });
      toast({ title: "گروه حذف شد" });
      load();
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    }
  };

  // ---- کالاها ----
  const openCreateProduct = (groupId?: string) => {
    if (!requireOnline()) return;
    setEditingProduct(null);
    setForm({
      ...emptyProduct,
      groupId: groupId || groups?.[0]?.id || "",
    });
    setProductDialog(true);
  };

  const openEditProduct = (p: Product) => {
    if (!requireOnline()) return;
    setEditingProduct(p);
    setForm({
      groupId: p.groupId,
      name: p.name,
      image: p.image || "",
      description: p.description || "",
      volume: p.volume || "",
      offer: p.offer || "",
      pricePurchase: String(p.pricePurchase || ""),
      priceStore: String(p.priceStore || ""),
      pricePharmacy: String(p.pricePharmacy || ""),
      priceSalon: String(p.priceSalon || ""),
      discount: String(p.discount || ""),
      minOrder: String(p.minOrder || 1),
    });
    setProductDialog(true);
  };

  const pickImage = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const dataUrl = await fileToCompressedDataUrl(file);
      setForm((f) => ({ ...f, image: dataUrl }));
    } catch (e) {
      toast({ title: "خطا در تصویر", description: (e as Error).message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  /** اعتبارسنجی فرم کالا — قبل از نمایش تایید */
  const validateProductForm = () => {
    if (!form.name.trim()) {
      toast({ title: "خطا", description: "نام کالا الزامی است", variant: "destructive" });
      return false;
    }
    if (!form.groupId) {
      toast({ title: "خطا", description: "ابتدا یک گروه کالایی بسازید", variant: "destructive" });
      return false;
    }
    return true;
  };

  const saveProduct = async () => {
    if (!validateProductForm()) return;
    setSaving(true);
    const body = {
      groupId: form.groupId,
      name: form.name,
      image: form.image,
      description: form.description,
      volume: form.volume,
      offer: form.offer,
      // قیمت خرید فقط با اجازه مدیر ویرایش/ثبت می‌شود
      pricePurchase: canPurchase ? Number(form.pricePurchase) || 0 : undefined,
      priceStore: Number(form.priceStore) || 0,
      pricePharmacy: Number(form.pricePharmacy) || 0,
      priceSalon: Number(form.priceSalon) || 0,
      discount: Number(form.discount) || 0,
      minOrder: Number(form.minOrder) || 1,
    };
    try {
      if (editingProduct) {
        await api(`/api/products/${editingProduct.id}`, { method: "PUT", body });
        toast({ title: "کالا ویرایش شد ✅" });
      } else {
        await api("/api/products", { method: "POST", body });
        toast({ title: "کالا ثبت شد ✅" });
      }
      setProductDialog(false);
      load();
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  /** ثبت/ویرایش کالا — ابتدا تایید، سپس اعمال + ارسال اعلان */
  const requestProductSave = () => {
    if (!validateProductForm()) return;
    requestConfirm(saveProduct);
  };

  const removeProduct = async (p: Product) => {
    try {
      await api(`/api/products/${p.id}`, { method: "DELETE" });
      toast({ title: "کالا حذف شد" });
      load();
    } catch (e) {
      toast({ title: "خطا", description: (e as Error).message, variant: "destructive" });
    }
  };

  const goToCatalog = () => {
    setView("catalogs");
  };

  return (
    <div className="space-y-3 app-fade">
      <div className="flex items-center justify-between gap-2">
        <h1 className="font-bold text-lg">کالا و گروه‌ها</h1>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" onClick={goToCatalog}>
            <FolderOpen className="h-4 w-4" /> کاتالوگ
          </Button>
          <Button size="sm" onClick={() => openCreateProduct()} aria-disabled={!online}>
            <Plus className="h-4 w-4" /> کالای جدید
          </Button>
        </div>
      </div>

      {/* اطلاع فقط‌خواندنی آفلاین — بخش ۵.۲ سند */}
      {!online && (
        <div
          role="status"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px] text-amber-800 dark:text-amber-300 flex items-center gap-2"
        >
          <CloudOff className="h-4 w-4 shrink-0" />
          <span>
            نمایش از آخرین همگام‌سازی دستگاه — ثبت/ویرایش کالا، گروه، قیمت و تخفیف در حالت آفلاین ممکن نیست.
          </span>
        </div>
      )}

      {!groups ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : groups.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center space-y-3">
            <Package className="h-10 w-10 text-muted-foreground/40 mx-auto" />
            <p className="text-sm text-muted-foreground">ابتدا یک گروه کالایی بسازید</p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                if (!requireOnline()) return;
                setEditingGroup(null);
                setGroupName("");
                setGroupDialog(true);
              }}
            >
              <FolderPlus className="h-4 w-4" /> ساخت گروه کالا
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Accordion type="multiple" defaultValue={groups.slice(0, 1).map((g) => g.id)}>
          {groups.map((g) => (
            <AccordionItem key={g.id} value={g.id} className="border rounded-xl mb-2 px-3 bg-card">
              <AccordionTrigger className="hover:no-underline py-3">
                <div className="flex items-center gap-2">
                  <FolderOpen className="h-4 w-4 text-primary" />
                  <span className="font-bold text-sm">{g.name}</span>
                  <Badge variant="secondary" className="text-[9px]">
                    {toFa(g.products.length)} کالا
                  </Badge>
                </div>
              </AccordionTrigger>
              <AccordionContent className="pb-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 text-[11px]"
                    onClick={() => openCreateProduct(g.id)}
                  >
                    <Plus className="h-3 w-3" /> کالای جدید در این گروه
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-[11px]"
                    onClick={() => {
                      if (!requireOnline()) return;
                      setEditingGroup(g);
                      setGroupName(g.name);
                      setGroupDialog(true);
                    }}
                  >
                    <Pencil className="h-3 w-3" /> ویرایش گروه
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-[11px] text-destructive"
                    onClick={() => requestConfirm(() => removeGroup(g))}
                  >
                    <Trash2 className="h-3 w-3" /> حذف گروه
                  </Button>
                </div>

                {g.products.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-4">کالایی در این گروه ثبت نشده</p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {g.products.map((p) => (
                      <Card key={p.id} className="overflow-hidden">
                        <CardContent className="p-2.5 flex gap-2.5">
                          <div className="w-16 h-16 rounded-lg bg-secondary/60 shrink-0 overflow-hidden flex items-center justify-center">
                            {p.image ? (
                              <Image src={p.image} alt={p.name} width={64} height={64} className="object-cover w-full h-full" unoptimized />
                            ) : (
                              <Package className="h-6 w-6 text-muted-foreground/40" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="font-bold text-xs leading-snug">{p.name}</div>
                            {p.volume && <div className="text-[10px] text-muted-foreground">حجم: {toFa(p.volume)}</div>}
                            {p.description && (
                              <p className="text-[10px] text-muted-foreground line-clamp-2 mt-0.5">{p.description}</p>
                            )}
                            <div className="flex flex-wrap gap-1 mt-1.5">
                              {p.offer && (
                                <Badge variant="secondary" className="text-[9px] gap-0.5 bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-0">
                                  <Gift className="h-2.5 w-2.5" /> آفر {toFa(p.offer)}
                                </Badge>
                              )}
                              {p.discount > 0 && (
                                <Badge variant="secondary" className="text-[9px] gap-0.5 bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300 border-0">
                                  <Percent className="h-2.5 w-2.5" /> {toFa(p.discount)}٪ تخفیف
                                </Badge>
                              )}
                            </div>
                            <div className="text-[10px] mt-1 space-y-0.5 text-muted-foreground">
                              {canPurchase && <div>خرید: {formatMoney(p.pricePurchase ?? 0)}</div>}
                              <div>فروشگاه: {formatMoney(p.priceStore)}</div>
                              <div>داروخانه: {formatMoney(p.pricePharmacy)} • سالن: {formatMoney(p.priceSalon)}</div>
                            </div>
                          </div>
                          <div className="flex flex-col gap-0.5 shrink-0">
                            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => openEditProduct(p)} aria-label="ویرایش کالا">
                              <Pencil className="h-3 w-3" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => requestConfirm(() => removeProduct(p))} aria-label="حذف کالا">
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      )}

      <Button
        variant="secondary"
        className="w-full"
        onClick={() => {
          if (!requireOnline()) return;
          setEditingGroup(null);
          setGroupName("");
          setGroupDialog(true);
        }}
      >
        <FolderPlus className="h-4 w-4" /> ساخت گروه جدید
      </Button>

      {/* دیالوگ گروه */}
      <Dialog open={groupDialog} onOpenChange={setGroupDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingGroup ? "ویرایش گروه" : "گروه کالایی جدید"}</DialogTitle>
            <DialogDescription>هر کالا در گروه خودش ساخته می‌شود</DialogDescription>
          </DialogHeader>
          <Input
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="مثلاً شامپو و نرم‌کننده"
            onKeyDown={(e) => e.key === "Enter" && requestGroupSave()}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setGroupDialog(false)}>
              انصراف
            </Button>
            <Button onClick={requestGroupSave} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} ذخیره
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* دیالوگ کالا */}
      <Dialog open={productDialog} onOpenChange={setProductDialog}>
        <DialogContent className="max-h-[88dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingProduct ? "ویرایش کالا" : "کالای جدید"}</DialogTitle>
            <DialogDescription>مشخصات کامل کالا شامل عکس، آفر، قیمت‌ها و تخفیف</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>گروه کالا *</Label>
              <Select value={form.groupId} onValueChange={(v) => setForm({ ...form, groupId: v })}>
                <SelectTrigger>
                  <SelectValue placeholder="انتخاب گروه" />
                </SelectTrigger>
                <SelectContent>
                  {(groups || []).map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-start gap-3">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="w-20 h-20 rounded-xl border-2 border-dashed border-border bg-secondary/40 flex flex-col items-center justify-center gap-1 hover:border-primary/50 transition-colors shrink-0"
              >
                {uploading ? (
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                ) : form.image ? (
                  <Image src={form.image} alt="پیش‌نمایش" width={80} height={80} className="object-cover w-full h-full rounded-xl" unoptimized />
                ) : (
                  <>
                    <Camera className="h-5 w-5 text-muted-foreground" />
                    <span className="text-[9px] text-muted-foreground">عکس محصول</span>
                  </>
                )}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => pickImage(e.target.files?.[0])}
              />
              <div className="flex-1 space-y-1.5">
                <Label>نام کالا *</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="مثلاً شامپو ترمیم‌کننده" />
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[11px]">حجم</Label>
                    <Input value={form.volume} onChange={(e) => setForm({ ...form, volume: e.target.value })} placeholder="400ml" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px]">تعداد سفارش</Label>
                    <Input inputMode="numeric" value={form.minOrder} onChange={(e) => setForm({ ...form, minOrder: e.target.value })} placeholder="1" />
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>توضیح کالا</Label>
              <Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="توضیحات محصول..." />
            </div>

            <div className="space-y-1.5">
              <Label className="flex items-center gap-1">
                <Gift className="h-3.5 w-3.5 text-emerald-600" /> آفر پیشنهادی (مثلاً 1+12)
              </Label>
              <Input value={form.offer} onChange={(e) => setForm({ ...form, offer: e.target.value })} placeholder="مثلاً 1+12" />
              <p className="text-[10px] text-muted-foreground">
                این آفر فقط به عنوان پیشنهاد نمایش داده می‌شود و در فاکتور به صورت دستی اضافه خواهد شد
              </p>
            </div>

            <div className="rounded-xl bg-secondary/40 p-3 space-y-2">
              <Label className="text-xs font-bold">قیمت‌ها (تومان)</Label>
              <div className="grid grid-cols-2 gap-2">
                {canPurchase && (
                  <div className="space-y-1">
                    <Label className="text-[11px]">قیمت خرید</Label>
                    <Input inputMode="numeric" value={form.pricePurchase} onChange={(e) => setForm({ ...form, pricePurchase: e.target.value })} placeholder="0" />
                  </div>
                )}
                <div className="space-y-1">
                  <Label className="text-[11px]">قیمت فروشگاه</Label>
                  <Input inputMode="numeric" value={form.priceStore} onChange={(e) => setForm({ ...form, priceStore: e.target.value })} placeholder="0" />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">قیمت داروخانه</Label>
                  <Input inputMode="numeric" value={form.pricePharmacy} onChange={(e) => setForm({ ...form, pricePharmacy: e.target.value })} placeholder="0" />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">قیمت سالن</Label>
                  <Input inputMode="numeric" value={form.priceSalon} onChange={(e) => setForm({ ...form, priceSalon: e.target.value })} placeholder="0" />
                </div>
              </div>
              {!canPurchase && (
                <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <Lock className="h-3 w-3" /> ثبت قیمت خرید فقط با اجازه مدیر امکان‌پذیر است
                </p>
              )}
              <div className="space-y-1">
                <Label className="text-[11px] flex items-center gap-1">
                  <Percent className="h-3 w-3" /> تخفیف کالا (درصد)
                </Label>
                <Input inputMode="numeric" value={form.discount} onChange={(e) => setForm({ ...form, discount: e.target.value })} placeholder="0" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setProductDialog(false)}>
              انصراف
            </Button>
            <Button onClick={requestProductSave} disabled={saving || uploading}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} ذخیره کالا
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* تایید اعمال تغییرات برای همه کاربران (۱۱-۴) — قبل از هر ثبت/ویرایش/حذف کالا یا گروه */}
      <AlertDialog
        open={confirmOpen}
        onOpenChange={(v) => {
          setConfirmOpen(v);
          if (!v) setPendingAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader className="text-right sm:text-right">
            <AlertDialogTitle className="text-base">اعمال تغییرات برای همه کاربران؟</AlertDialogTitle>
            <AlertDialogDescription className="text-xs leading-6">
              با تایید، این تغییرات بلافاصله برای همه کاربران اعمال و اعلان بروزرسانی برای آنها ارسال می‌شود.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row-reverse justify-start gap-2">
            <AlertDialogCancel disabled={saving}>بازبینی</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void runPending()}
              disabled={saving}
              className="gap-1.5"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} اعمال و ارسال اعلان
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
