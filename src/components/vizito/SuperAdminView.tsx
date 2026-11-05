"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { SupportInbox } from "@/components/vizito/SupportInbox";
import { formatJalali, formatJalaliDateTime, formatMoney, toFa, toEnDigits } from "@/lib/jalali";
import { toast } from "@/hooks/use-toast";
import {
  Building2,
  ShieldCheck,
  ScrollText,
  Search,
  ArrowRight,
  Copy,
  Users,
  Package,
  ClipboardList,
  BarChart3,
  Gem,
  KeyRound,
  History,
  Pause,
  Play,
  Eye,
  Phone,
  Smartphone,
  UserCog,
  UsersRound,
  Layers,
  Plus,
  LifeBuoy,
} from "lucide-react";

/**
 * پنل مدیریت کل (فقط سازنده برنامه / SUPER_ADMIN)
 * -----------------------------------------------------------------------------
 * - مجموعه‌ها: فهرست + جست‌وجو (نام/مدیر/موبایل) + فیلتر وضعیت و لایسنس + جمع‌بندی
 * - جزئیات مجموعه: فقط-مشاهده (خلاصه/کاربران/کالا/مشتریان/سفارش‌ها/گزارش)
 * - لایسنس: صدور مستقیم، تولید کلید VZT3، تمدید، تعلیق/رفع تعلیق + سوابق
 * - لاگ دسترسی: دفتر حسابرسی AdminAccessLog — append-only
 * هر مشاهده سمت سرور ثبت می‌شود؛ رمز عبور هیچ‌گاه در هیچ پاسخی وجود ندارد.
 */

// ─────────────────────────── انواع ───────────────────────────

type LicenseSummary = { plan: string; expiresAt: string | null; status: string } | null;

type SaOrg = {
  id: string;
  name: string;
  status: string;
  trialEndsAt: string | null;
  createdAt: string;
  usersCount: number;
  admin: { name: string; mobile: string } | null;
  license: LicenseSummary;
  licenseState: string;
};

type OrgsResp = {
  orgs: SaOrg[];
  total: number;
  page: number;
  pageSize: number;
  summary: { total: number; active: number; suspended: number; trial: number; expired: number; noLicense: number };
};

type Overview = {
  org: {
    id: string;
    name: string;
    status: string;
    suspendedAt: string | null;
    trialStartsAt: string | null;
    trialEndsAt: string | null;
    createdAt: string;
  };
  license: LicenseSummary;
  licenseState: string;
  admin: { id: string; name: string; mobile: string; company: string | null; createdAt: string } | null;
  counts: {
    users: number;
    products: number;
    groups: number;
    customers: number;
    orders: number;
    canceledOrders: number;
    payments: number;
    totalSales: number;
    devices: number;
  };
  events: { id: string; type: string; plan: string | null; days: number | null; actorName: string | null; note: string | null; createdAt: string }[];
};

type UsersResp = {
  users: {
    id: string;
    name: string;
    mobile: string;
    company: string | null;
    role: string;
    kind: string;
    disabled: boolean;
    createdAt: string;
    grant: { sections: string; expiresAt: string | null } | null;
  }[];
};

type ProductsResp = {
  groups: { id: string; name: string; createdAt: string; productsCount: number }[];
  products: {
    id: string;
    name: string;
    groupId: string;
    volume: string | null;
    offer: string | null;
    pricePurchase: number;
    priceStore: number;
    pricePharmacy: number;
    priceSalon: number;
    discount: number;
    createdAt: string;
  }[];
};

type CustomersResp = {
  customers: {
    id: string;
    name: string;
    company: string | null;
    phone: string;
    type: string;
    archived: boolean;
    createdAt: string;
    createdBy: string | null;
    ordersCount: number;
  }[];
};

type OrdersResp = {
  orders: {
    id: string;
    title: string | null;
    status: string;
    priceType: string;
    totalAmount: number;
    settlementType: string | null;
    createdOffline: boolean;
    needsReview: boolean;
    createdAt: string;
    customer: { id: string; name: string; phone: string };
    createdBy: string | null;
    itemsCount: number;
  }[];
};

type ReportsResp = {
  orderCount: number;
  totalSales: number;
  monthSales: number;
  topCustomers: { customerId: string; name: string; count: number; total: number }[];
  topProducts: { name: string; qty: number; total: number }[];
};

type AccessLog = {
  id: string;
  actorId: string;
  actorName: string | null;
  orgId: string | null;
  action: string;
  detail: string | null;
  ip: string | null;
  createdAt: string;
};

type LogsResp = { logs: AccessLog[]; total: number; page: number; pageSize: number };

// ─────────────────────────── کمکی ───────────────────────────

const PLAN_LABELS: Record<string, string> = {
  D30: "۳۰ روزه",
  D90: "۹۰ روزه",
  D180: "۱۸۰ روزه",
  D365: "۳۶۵ روزه",
  PERM: "دائمی",
};

const STATE_STYLES: Record<string, { label: string; cls: string }> = {
  ACTIVE: { label: "فعال", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
  TRIAL: { label: "در حال تریال", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  EXPIRED: { label: "منقضی", cls: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300" },
  SUSPENDED: { label: "تعلیق", cls: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300" },
  NONE: { label: "بدون لایسنس", cls: "bg-secondary text-secondary-foreground" },
};

function stateBadge(state: string) {
  const s = STATE_STYLES[state] || STATE_STYLES.NONE;
  return <Badge className={`text-[9px] border-0 ${s.cls}`}>{s.label}</Badge>;
}

function daysLeft(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const diff = new Date(iso).getTime() - Date.now();
  return Math.ceil(diff / 86_400_000);
}

function planLabel(plan: string | null | undefined): string {
  return plan ? PLAN_LABELS[plan] || plan : "—";
}

function actionLabel(action: string): string {
  const map: Record<string, string> = {
    VIEW_ORGS: "مشاهده فهرست مجموعه‌ها",
    VIEW_ORG: "مشاهده مجموعه",
    VIEW_USERS: "مشاهده کاربران",
    VIEW_PRODUCTS: "مشاهده کالاها",
    VIEW_CUSTOMERS: "مشاهده مشتریان",
    VIEW_ORDERS: "مشاهده سفارش‌ها",
    VIEW_REPORTS: "مشاهده گزارش‌ها",
    VIEW_LICENSE: "مشاهده لایسنس",
    VIEW_LICENSES: "مشاهده لایسنس‌ها",
    VIEW_ACCESS_LOGS: "مشاهده لاگ دسترسی",
    ISSUE_LICENSE: "صدور لایسنس",
    ISSUE_LICENSE_KEY: "تولید کلید لایسنس",
    EXTEND_LICENSE: "تمدید لایسنس",
    SUSPEND_ORG: "تعلیق مجموعه",
    RESUME_ORG: "رفع تعلیق",
  };
  return map[action] || action;
}

function copyText(text: string, label: string) {
  navigator.clipboard?.writeText(text).then(
    () => toast({ title: `${label} کپی شد` }),
    () => toast({ title: "کپی ناموفق بود" })
  );
}

// ─────────────────────────── نمای اصلی ───────────────────────────

export function SuperAdminView() {
  const [level, setLevel] = useState<"root" | "org">("root");
  const [orgId, setOrgId] = useState<string | null>(null);
  const [rootTab, setRootTab] = useState<"orgs" | "logs" | "support">("orgs");

  return (
    <div className="space-y-3">
      {/* سربرگ پنل + حریم خصوصی */}
      <Card>
        <CardContent className="p-3 space-y-1.5">
          <div className="text-xs font-bold flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-primary" /> مدیریت کل — پنل سازنده
          </div>
          <p className="text-[10px] text-muted-foreground leading-5">
            مشاهده مجموعه‌ها فقط برای پشتیبانی است و «فقط-خواندنی»؛ هر دسترسی شما در لاگ حسابرسی ثبت می‌شود و
            رمز عبور هیچ کاربری هرگز نمایش داده نمی‌شود.
          </p>
        </CardContent>
      </Card>

      {level === "org" && orgId ? (
        <OrgDetail orgId={orgId} onBack={() => { setLevel("root"); setOrgId(null); }} />
      ) : (
        <>
          {/* تب سطح ریشه */}
          <div className="grid grid-cols-3 gap-2">
            <Button
              size="sm"
              variant={rootTab === "orgs" ? "default" : "outline"}
              onClick={() => setRootTab("orgs")}
              className="gap-1.5"
            >
              <Building2 className="h-3.5 w-3.5" /> مجموعه‌ها
            </Button>
            <Button
              size="sm"
              variant={rootTab === "support" ? "default" : "outline"}
              onClick={() => setRootTab("support")}
              className="gap-1.5"
            >
              <LifeBuoy className="h-3.5 w-3.5" /> پشتیبانی
            </Button>
            <Button
              size="sm"
              variant={rootTab === "logs" ? "default" : "outline"}
              onClick={() => setRootTab("logs")}
              className="gap-1.5"
            >
              <ScrollText className="h-3.5 w-3.5" /> لاگ دسترسی
            </Button>
          </div>
          {rootTab === "orgs" ? (
            <OrgsList
              onOpen={(id) => {
                setOrgId(id);
                setLevel("org");
              }}
            />
          ) : rootTab === "support" ? (
            <SupportInbox />
          ) : (
            <AccessLogs />
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────────── فهرست مجموعه‌ها ───────────────────────────

function OrgsList({ onOpen }: { onOpen: (id: string) => void }) {
  const [data, setData] = useState<OrgsResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [licenseF, setLicenseF] = useState("all");
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ page: String(page), pageSize: "20" });
      if (q.trim()) p.set("q", q.trim());
      if (status !== "all") p.set("status", status);
      if (licenseF !== "all") p.set("license", licenseF);
      const res = await api<OrgsResp>(`/api/sa/orgs?${p.toString()}`);
      setData(res);
    } catch (e) {
      toast({ title: (e as Error).message || "خطا در دریافت مجموعه‌ها" });
    } finally {
      setLoading(false);
    }
  }, [q, status, licenseF, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const s = data?.summary;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-3">
      {/* جمع‌بندی */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: "کل", value: s?.total, icon: Building2 },
          { label: "فعال", value: s?.active, cls: "text-emerald-600 dark:text-emerald-400" },
          { label: "تریال", value: s?.trial, cls: "text-amber-600 dark:text-amber-400" },
          { label: "منقضی", value: s?.expired, cls: "text-rose-600 dark:text-rose-400" },
          { label: "تعلیق", value: s?.suspended, cls: "text-rose-600 dark:text-rose-400" },
          { label: "بدون لایسنس", value: s?.noLicense, cls: "text-muted-foreground" },
        ].map((it) => (
          <Card key={it.label}>
            <CardContent className="p-2 text-center">
              <div className={`text-sm font-black ${it.cls || ""}`}>{it.value === undefined ? "—" : toFa(it.value)}</div>
              <div className="text-[9px] text-muted-foreground">{it.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* جست‌وجو و فیلتر */}
      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="relative">
            <Search className="absolute right-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              placeholder="جست‌وجو: نام مجموعه، نام یا موبایل مدیر"
              className="pr-8 text-xs"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
              <SelectTrigger className="text-[11px] h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">همه وضعیت‌ها</SelectItem>
                <SelectItem value="ACTIVE">فعال</SelectItem>
                <SelectItem value="SUSPENDED">تعلیق</SelectItem>
              </SelectContent>
            </Select>
            <Select value={licenseF} onValueChange={(v) => { setLicenseF(v); setPage(1); }}>
              <SelectTrigger className="text-[11px] h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">همه لایسنس‌ها</SelectItem>
                <SelectItem value="TRIAL">در حال تریال</SelectItem>
                <SelectItem value="ACTIVE">لایسنس فعال</SelectItem>
                <SelectItem value="EXPIRED">منقضی</SelectItem>
                <SelectItem value="SUSPENDED">تعلیق</SelectItem>
                <SelectItem value="NONE">بدون لایسنس</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* فهرست */}
      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
      ) : !data || data.orgs.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-xs text-muted-foreground">مجموعه‌ای یافت نشد</CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {data.orgs.map((o) => (
            <Card key={o.id} className="cursor-pointer hover:bg-accent/40 transition-colors" onClick={() => onOpen(o.id)}>
              <CardContent className="p-3 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Building2 className="h-3.5 w-3.5 text-primary shrink-0" />
                    <span className="text-xs font-bold truncate">{o.name}</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {stateBadge(o.licenseState)}
                    {o.status === "SUSPENDED" && (
                      <Badge className="text-[9px] border-0 bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300">
                        مجموعه تعلیق
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="text-[10px] text-muted-foreground flex items-center gap-3 flex-wrap">
                  <span className="flex items-center gap-1"><UserCog className="h-3 w-3" />{o.admin ? `${o.admin.name} — ${toFa(o.admin.mobile)}` : "—"}</span>
                  <span className="flex items-center gap-1"><Users className="h-3 w-3" />{toFa(o.usersCount)} کاربر</span>
                  <span className="flex items-center gap-1">
                    <Gem className="h-3 w-3" />
                    {planLabel(o.license?.plan)}
                    {o.licenseState === "ACTIVE" && o.license?.expiresAt
                      ? ` — ${toFa(Math.max(0, daysLeft(o.license.expiresAt) ?? 0))} روز`
                      : ""}
                  </span>
                </div>
                <div className="text-[9px] text-muted-foreground">ساخت: {formatJalali(o.createdAt)} · شناسه: {o.id.slice(0, 10)}…</div>
              </CardContent>
            </Card>
          ))}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-1">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>قبلی</Button>
              <span className="text-[10px] text-muted-foreground">{toFa(page)} از {toFa(totalPages)}</span>
              <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>بعدی</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────── جزئیات مجموعه ───────────────────────────

const DETAIL_TABS = [
  { key: "overview", label: "خلاصه", icon: Layers },
  { key: "users", label: "کاربران", icon: Users },
  { key: "products", label: "کالا", icon: Package },
  { key: "customers", label: "مشتریان", icon: UsersRound },
  { key: "orders", label: "سفارش‌ها", icon: ClipboardList },
  { key: "reports", label: "گزارش", icon: BarChart3 },
  { key: "license", label: "لایسنس", icon: Gem },
] as const;

function OrgDetail({ orgId, onBack }: { orgId: string; onBack: () => void }) {
  const [tab, setTab] = useState<(typeof DETAIL_TABS)[number]["key"]>("overview");

  return (
    <div className="space-y-3">
      <Button size="sm" variant="ghost" onClick={onBack} className="gap-1 text-xs">
        <ArrowRight className="h-3.5 w-3.5" /> بازگشت به فهرست
      </Button>

      <div className="grid grid-cols-4 gap-1.5 overflow-x-auto">
        {DETAIL_TABS.map((t) => (
          <Button
            key={t.key}
            size="sm"
            variant={tab === t.key ? "default" : "outline"}
            onClick={() => setTab(t.key)}
            className="gap-1 text-[10px] px-2 h-8"
          >
            <t.icon className="h-3 w-3" /> {t.label}
          </Button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab orgId={orgId} />}
      {tab === "users" && <UsersTab orgId={orgId} />}
      {tab === "products" && <ProductsTab orgId={orgId} />}
      {tab === "customers" && <CustomersTab orgId={orgId} />}
      {tab === "orders" && <OrdersTab orgId={orgId} />}
      {tab === "reports" && <ReportsTab orgId={orgId} />}
      {tab === "license" && <LicenseTab orgId={orgId} />}
    </div>
  );
}

/** سربرگ مشترک مجموعه در تب‌های جزئیات */
type OrgHeaderOrg = {
  id: string;
  name: string;
  status: string;
  trialEndsAt: string | null;
  createdAt: string;
};

function OrgHeader({ org, license, licenseState }: { org: OrgHeaderOrg; license: LicenseSummary; licenseState: string }) {
  const dl = daysLeft(org.trialEndsAt);
  return (
    <Card>
      <CardContent className="p-3 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <Building2 className="h-4 w-4 text-primary shrink-0" />
            <span className="text-sm font-black truncate">{org.name}</span>
          </div>
          <div className="flex gap-1 shrink-0">
            {stateBadge(licenseState)}
            {org.status === "SUSPENDED" && (
              <Badge className="text-[9px] border-0 bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300">تعلیق</Badge>
            )}
          </div>
        </div>
        <button
          onClick={() => copyText(org.id, "شناسه مجموعه")}
          className="text-[10px] text-muted-foreground flex items-center gap-1 hover:text-foreground"
          aria-label="کپی شناسه مجموعه"
        >
          <Copy className="h-3 w-3" /> شناسه: {org.id}
        </button>
        <div className="text-[10px] text-muted-foreground">
          {license
            ? `لایسنس: ${planLabel(license.plan)}${
                license.expiresAt ? ` — انقضا: ${formatJalali(license.expiresAt)}` : " — بدون انقضا"
              }`
            : dl !== null
              ? `ترِیال مجموعه — ${dl > 0 ? `${toFa(dl)} روز باقی‌مانده` : "پایان یافته"}`
              : "بدون لایسنس فعال"}
        </div>
      </CardContent>
    </Card>
  );
}

function useSaTab<T>(orgId: string, tab: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api<T>(`/api/sa/orgs?orgId=${orgId}&tab=${tab}`));
    } catch (e) {
      toast({ title: (e as Error).message || "خطا در دریافت داده" });
    } finally {
      setLoading(false);
    }
  }, [orgId, tab]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, loading, reload: load };
}

function OverviewTab({ orgId }: { orgId: string }) {
  const { data, loading } = useSaTab<Overview>(orgId, "overview");
  if (loading || !data) return <Skeleton className="h-40 w-full" />;
  const c = data.counts;
  const cells = [
    { label: "کاربران", value: c.users },
    { label: "کالاها", value: c.products },
    { label: "گروه‌ها", value: c.groups },
    { label: "مشتریان", value: c.customers },
    { label: "سفارش‌ها", value: c.orders },
    { label: "لغوشده", value: c.canceledOrders },
    { label: "تسویه‌ها", value: c.payments },
    { label: "دستگاه‌ها", value: c.devices },
  ];
  return (
    <div className="space-y-3">
      <OrgHeader org={data.org} license={data.license} licenseState={data.licenseState} />
      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="grid grid-cols-4 gap-2">
            {cells.map((it) => (
              <div key={it.label} className="rounded-lg bg-secondary/50 p-2 text-center">
                <div className="text-xs font-black">{toFa(it.value)}</div>
                <div className="text-[9px] text-muted-foreground">{it.label}</div>
              </div>
            ))}
          </div>
          <Separator />
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">جمع فروش (بدون لغوشده)</span>
            <span className="font-bold text-primary">{formatMoney(c.totalSales)}</span>
          </div>
          {data.admin && (
            <div className="text-[10px] text-muted-foreground flex items-center gap-3">
              <span className="flex items-center gap-1"><UserCog className="h-3 w-3" />مدیر: {data.admin.name}</span>
              <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{toFa(data.admin.mobile)}</span>
            </div>
          )}
          <div className="text-[9px] text-muted-foreground">ساخت مجموعه: {formatJalaliDateTime(data.org.createdAt)}</div>
        </CardContent>
      </Card>
      {data.events.length > 0 && (
        <Card>
          <CardContent className="p-3 space-y-1.5">
            <div className="text-xs font-bold flex items-center gap-1.5"><History className="h-3.5 w-3.5 text-primary" />آخرین رویدادهای لایسنس</div>
            {data.events.map((e) => (
              <div key={e.id} className="text-[10px] flex items-center justify-between gap-2 border-b border-border/40 pb-1 last:border-0">
                <span className="font-semibold">{actionLabel(e.type)}</span>
                <span className="text-muted-foreground">{formatJalaliDateTime(e.createdAt)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function UsersTab({ orgId }: { orgId: string }) {
  const { data, loading } = useSaTab<UsersResp>(orgId, "users");
  if (loading) return <Skeleton className="h-40 w-full" />;
  if (!data || data.users.length === 0)
    return <Card><CardContent className="p-6 text-center text-xs text-muted-foreground">کاربری نیست</CardContent></Card>;
  return (
    <div className="space-y-2 max-h-[60vh] overflow-y-auto">
      {data.users.map((u) => (
        <Card key={u.id}>
          <CardContent className="p-3 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold flex items-center gap-1.5"><Users className="h-3.5 w-3.5 text-primary" />{u.name}</span>
              <div className="flex gap-1">
                <Badge variant="secondary" className="text-[9px]">{u.role}</Badge>
                {u.disabled && (
                  <Badge className="text-[9px] border-0 bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300">غیرفعال</Badge>
                )}
              </div>
            </div>
            <div className="text-[10px] text-muted-foreground flex items-center gap-3 flex-wrap">
              <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{toFa(u.mobile)}</span>
              {u.company && <span>{u.company}</span>}
              <span>عضویت: {formatJalali(u.createdAt)}</span>
            </div>
            {u.grant && (
              <div className="text-[9px] text-muted-foreground">
                دسترسی: {u.grant.expiresAt ? `تا ${formatJalali(u.grant.expiresAt)}` : "دائمی"}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ProductsTab({ orgId }: { orgId: string }) {
  const { data, loading } = useSaTab<ProductsResp>(orgId, "products");
  if (loading) return <Skeleton className="h-40 w-full" />;
  if (!data || data.products.length === 0)
    return <Card><CardContent className="p-6 text-center text-xs text-muted-foreground">کالایی نیست</CardContent></Card>;
  return (
    <div className="space-y-2">
      <Card>
        <CardContent className="p-3">
          <div className="text-xs font-bold mb-1.5 flex items-center gap-1.5"><Layers className="h-3.5 w-3.5 text-primary" />گروه‌ها ({toFa(data.groups.length)})</div>
          <div className="flex flex-wrap gap-1">
            {data.groups.map((g) => (
              <Badge key={g.id} variant="secondary" className="text-[9px]">{g.name} ({toFa(g.productsCount)})</Badge>
            ))}
          </div>
        </CardContent>
      </Card>
      <div className="space-y-2 max-h-[55vh] overflow-y-auto">
        {data.products.map((p) => (
          <Card key={p.id}>
            <CardContent className="p-3 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold">{p.name}</span>
                {p.offer && <Badge variant="secondary" className="text-[9px]">{p.offer}</Badge>}
              </div>
              <div className="text-[10px] text-muted-foreground flex items-center gap-3 flex-wrap">
                <span>فروشگاه: {formatMoney(p.priceStore)}</span>
                <span>داروخانه: {formatMoney(p.pricePharmacy)}</span>
                <span>سالن: {formatMoney(p.priceSalon)}</span>
                {p.volume && <span>حجم: {p.volume}</span>}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function CustomersTab({ orgId }: { orgId: string }) {
  const { data, loading } = useSaTab<CustomersResp>(orgId, "customers");
  if (loading) return <Skeleton className="h-40 w-full" />;
  if (!data || data.customers.length === 0)
    return <Card><CardContent className="p-6 text-center text-xs text-muted-foreground">مشتری‌ای نیست</CardContent></Card>;
  return (
    <div className="space-y-2 max-h-[60vh] overflow-y-auto">
      {data.customers.map((c) => (
        <Card key={c.id}>
          <CardContent className="p-3 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold">{c.name}</span>
              <div className="flex gap-1">
                {c.archived && (
                  <Badge variant="secondary" className="text-[9px]">آرشیو</Badge>
                )}
                <Badge variant="secondary" className="text-[9px]">{toFa(c.ordersCount)} سفارش</Badge>
              </div>
            </div>
            <div className="text-[10px] text-muted-foreground flex items-center gap-3 flex-wrap">
              <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{toFa(c.phone)}</span>
              {c.company && <span>{c.company}</span>}
              {c.createdBy && <span>ثبت: {c.createdBy}</span>}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function OrdersTab({ orgId }: { orgId: string }) {
  const { data, loading } = useSaTab<OrdersResp>(orgId, "orders");
  if (loading) return <Skeleton className="h-40 w-full" />;
  if (!data || data.orders.length === 0)
    return <Card><CardContent className="p-6 text-center text-xs text-muted-foreground">سفارشی نیست</CardContent></Card>;
  return (
    <div className="space-y-2 max-h-[60vh] overflow-y-auto">
      {data.orders.map((o) => (
        <Card key={o.id}>
          <CardContent className="p-3 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold">{o.customer.name}</span>
              <span className="text-xs font-black text-primary">{formatMoney(o.totalAmount)}</span>
            </div>
            <div className="text-[10px] text-muted-foreground flex items-center gap-3 flex-wrap">
              <span>{formatJalaliDateTime(o.createdAt)}</span>
              <span>{toFa(o.itemsCount)} قلم</span>
              {o.createdBy && <span>ثبت: {o.createdBy}</span>}
              {o.status === "CANCELED" && <Badge variant="secondary" className="text-[9px]">لغوشده</Badge>}
              {o.createdOffline && <Badge variant="secondary" className="text-[9px]">آفلاین</Badge>}
              {o.needsReview && (
                <Badge className="text-[9px] border-0 bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                  نیازمند بررسی
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ReportsTab({ orgId }: { orgId: string }) {
  const { data, loading } = useSaTab<ReportsResp>(orgId, "reports");
  if (loading || !data) return <Skeleton className="h-40 w-full" />;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <Card><CardContent className="p-2 text-center">
          <div className="text-xs font-black text-primary">{formatMoney(data.totalSales)}</div>
          <div className="text-[9px] text-muted-foreground">جمع فروش کل</div>
        </CardContent></Card>
        <Card><CardContent className="p-2 text-center">
          <div className="text-xs font-black">{formatMoney(data.monthSales)}</div>
          <div className="text-[9px] text-muted-foreground">فروش ۳۰ روز اخیر</div>
        </CardContent></Card>
        <Card><CardContent className="p-2 text-center">
          <div className="text-xs font-black">{toFa(data.orderCount)}</div>
          <div className="text-[9px] text-muted-foreground">تعداد فاکتور</div>
        </CardContent></Card>
      </div>
      <Card>
        <CardContent className="p-3 space-y-1.5">
          <div className="text-xs font-bold flex items-center gap-1.5"><UsersRound className="h-3.5 w-3.5 text-primary" />برترین مشتریان</div>
          {data.topCustomers.length === 0 && <div className="text-[10px] text-muted-foreground">داده‌ای نیست</div>}
          {data.topCustomers.map((c) => (
            <div key={c.customerId} className="flex items-center justify-between text-[10px] border-b border-border/40 pb-1 last:border-0">
              <span className="font-semibold">{c.name}</span>
              <span className="text-muted-foreground">{toFa(c.count)} فاکتور — {formatMoney(c.total)}</span>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-3 space-y-1.5">
          <div className="text-xs font-bold flex items-center gap-1.5"><Package className="h-3.5 w-3.5 text-primary" />پرفروش‌ترین کالاها</div>
          {data.topProducts.length === 0 && <div className="text-[10px] text-muted-foreground">داده‌ای نیست</div>}
          {data.topProducts.map((p) => (
            <div key={p.name} className="flex items-center justify-between text-[10px] border-b border-border/40 pb-1 last:border-0">
              <span className="font-semibold">{p.name}</span>
              <span className="text-muted-foreground">{toFa(p.qty)} عدد — {formatMoney(p.total)}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

// ─────────────────────────── مدیریت لایسنس مجموعه ───────────────────────────

type LicenseDetail = {
  org: { id: string; name: string; status: string; trialEndsAt: string | null; createdAt: string };
  admin: { name: string; mobile: string; company: string | null } | null;
  users: { id: string; name: string; mobile: string; role: string; disabled: boolean; createdAt: string }[];
  license: LicenseSummary;
  events: { id: string; type: string; plan: string | null; days: number | null; actorName: string | null; note: string | null; createdAt: string }[];
};

function LicenseTab({ orgId }: { orgId: string }) {
  const [data, setData] = useState<LicenseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState("D30");
  const [extendDays, setExtendDays] = useState("30");
  const [newKey, setNewKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api<LicenseDetail>(`/api/sa/license?orgId=${orgId}`));
    } catch (e) {
      toast({ title: (e as Error).message || "خطا در دریافت لایسنس" });
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      const res = await api<{ ok: boolean; key?: string; expiresAt?: string | null }>("/api/sa/license", {
        method: "POST",
        body: { action, orgId, ...extra },
      });
      if (action === "issueKey" && res.key) {
        setNewKey(res.key);
        toast({ title: "کلید VZT3 تولید شد — آن را برای مدیر مجموعه ارسال کنید" });
      } else {
        toast({ title: "عملیات انجام شد" });
      }
      await load();
    } catch (e) {
      toast({ title: (e as Error).message || "خطا در عملیات" });
    } finally {
      setBusy(false);
    }
  };

  if (loading || !data) return <Skeleton className="h-40 w-full" />;
  const lic = data.license;
  const suspended = data.org.status === "SUSPENDED";

  return (
    <div className="space-y-3">
      <OrgHeader org={data.org} license={lic} licenseState={suspended ? "SUSPENDED" : lic ? (lic.plan === "PERM" || !lic.expiresAt || new Date(lic.expiresAt).getTime() > Date.now() ? "ACTIVE" : "EXPIRED") : data.org.trialEndsAt && new Date(data.org.trialEndsAt).getTime() > Date.now() ? "TRIAL" : "NONE"} />

      {/* وضعیت فعلی */}
      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="text-xs font-bold flex items-center gap-1.5"><Gem className="h-3.5 w-3.5 text-primary" />لایسنس فعلی</div>
          {lic ? (
            <div className="text-[10px] text-muted-foreground space-y-0.5">
              <div>مدت: {planLabel(lic.plan)} — وضعیت: {lic.status === "ACTIVE" ? "فعال" : "تعلیق"}</div>
              <div>
                {lic.expiresAt
                  ? `انقضا: ${formatJalaliDateTime(lic.expiresAt)} — ${toFa(Math.max(0, daysLeft(lic.expiresAt) ?? 0))} روز مانده`
                  : "بدون انقضا (دائمی)"}
              </div>
            </div>
          ) : (
            <div className="text-[10px] text-muted-foreground">این مجموعه هنوز لایسنس ندارد (در حال تریال یا بدون لایسنس).</div>
          )}
          <Separator />
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <div className="text-[10px] text-muted-foreground">صدور مستقیم / تعویض مدت</div>
              <Select value={plan} onValueChange={setPlan}>
                <SelectTrigger className="text-[11px] h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="D30">۳۰ روزه</SelectItem>
                  <SelectItem value="D90">۹۰ روزه</SelectItem>
                  <SelectItem value="D180">۱۸۰ روزه</SelectItem>
                  <SelectItem value="D365">۳۶۵ روزه</SelectItem>
                  <SelectItem value="PERM">دائمی</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" disabled={busy} onClick={() => act("issue", { plan })} className="w-full gap-1 text-[11px]">
                <Plus className="h-3 w-3" /> صدور مستقیم
              </Button>
            </div>
            <div className="space-y-1">
              <div className="text-[10px] text-muted-foreground">تولید کلید VZT3 (فعال‌سازی توسط مشتری)</div>
              <div className="h-8" />
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => act("issueKey", { plan })} className="w-full gap-1 text-[11px]">
                <KeyRound className="h-3 w-3" /> تولید کلید
              </Button>
            </div>
          </div>
          {lic && lic.plan !== "PERM" && (
            <div className="space-y-1">
              <div className="text-[10px] text-muted-foreground">تمدید زودهنگام — از انقضای فعلی اضافه می‌شود</div>
              <div className="flex gap-2">
                <Input
                  value={extendDays}
                  onChange={(e) => setExtendDays(e.target.value)}
                  inputMode="numeric"
                  className="text-xs h-8 w-24"
                  aria-label="تعداد روز تمدید"
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => act("extend", { days: Number(toEnDigits(extendDays)) || 0 })}
                  className="gap-1 text-[11px]"
                >
                  <History className="h-3 w-3" /> تمدید
                </Button>
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2 pt-1">
            {suspended ? (
              <Button size="sm" disabled={busy} onClick={() => act("resume")} className="gap-1 text-[11px]">
                <Play className="h-3 w-3" /> رفع تعلیق مجموعه
              </Button>
            ) : (
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("مجموعه تعلیق شود؟ همه عملیات تجاری آن ۴۰۲ می‌شود (داده‌ها حفظ می‌شوند).")) void act("suspend");
                }}
                className="gap-1 text-[11px]"
              >
                <Pause className="h-3 w-3" /> تعلیق مجموعه
              </Button>
            )}
          </div>
          {newKey && (
            <Card className="border-primary/40">
              <CardContent className="p-2.5 space-y-1">
                <div className="text-[10px] font-bold text-primary flex items-center gap-1"><KeyRound className="h-3 w-3" />کلید تولیدشده (یک‌بار نمایش در اینجا)</div>
                <div className="text-[9px] font-mono break-all bg-secondary/60 rounded p-2 leading-5">{newKey}</div>
                <Button size="sm" variant="outline" onClick={() => copyText(newKey, "کلید")} className="w-full gap-1 text-[11px]">
                  <Copy className="h-3 w-3" /> کپی کلید
                </Button>
              </CardContent>
            </Card>
          )}
        </CardContent>
      </Card>

      {/* سوابق */}
      <Card>
        <CardContent className="p-3 space-y-1.5">
          <div className="text-xs font-bold flex items-center gap-1.5"><History className="h-3.5 w-3.5 text-primary" />سوابق لایسنس ({toFa(data.events.length)})</div>
          <div className="max-h-64 overflow-y-auto space-y-1">
            {data.events.length === 0 && <div className="text-[10px] text-muted-foreground">سابقه‌ای نیست</div>}
            {data.events.map((e) => (
              <div key={e.id} className="text-[10px] border-b border-border/40 pb-1.5 last:border-0 space-y-0.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{actionLabel(e.type)}{e.plan ? ` (${planLabel(e.plan)})` : ""}{e.days ? ` +${toFa(e.days)} روز` : ""}</span>
                  <span className="text-muted-foreground">{formatJalaliDateTime(e.createdAt)}</span>
                </div>
                {(e.note || e.actorName) && (
                  <div className="text-muted-foreground">{e.note}{e.actorName ? ` — ${e.actorName}` : ""}</div>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─────────────────────────── لاگ دسترسی ───────────────────────────

function AccessLogs() {
  const [data, setData] = useState<LogsResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ page: String(page), pageSize: "30" });
      if (action !== "all") p.set("action", action);
      if (q.trim()) p.set("q", q.trim());
      setData(await api<LogsResp>(`/api/sa/access-logs?${p.toString()}`));
    } catch (e) {
      toast({ title: (e as Error).message || "خطا در دریافت لاگ" });
    } finally {
      setLoading(false);
    }
  }, [action, q, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="relative">
            <Search className="absolute right-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              placeholder="جست‌وجو در نام کاربر/عملیات"
              className="pr-8 text-xs"
            />
          </div>
          <Select value={action} onValueChange={(v) => { setAction(v); setPage(1); }}>
            <SelectTrigger className="text-[11px] h-8"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">همه عملیات</SelectItem>
              <SelectItem value="VIEW_ORGS">مشاهده فهرست مجموعه‌ها</SelectItem>
              <SelectItem value="VIEW_ORG">مشاهده مجموعه</SelectItem>
              <SelectItem value="VIEW_USERS">مشاهده کاربران</SelectItem>
              <SelectItem value="VIEW_PRODUCTS">مشاهده کالاها</SelectItem>
              <SelectItem value="VIEW_CUSTOMERS">مشاهده مشتریان</SelectItem>
              <SelectItem value="VIEW_ORDERS">مشاهده سفارش‌ها</SelectItem>
              <SelectItem value="VIEW_REPORTS">مشاهده گزارش‌ها</SelectItem>
              <SelectItem value="ISSUE_LICENSE">صدور لایسنس</SelectItem>
              <SelectItem value="ISSUE_LICENSE_KEY">تولید کلید</SelectItem>
              <SelectItem value="EXTEND_LICENSE">تمدید</SelectItem>
              <SelectItem value="SUSPEND_ORG">تعلیق</SelectItem>
              <SelectItem value="RESUME_ORG">رفع تعلیق</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {loading ? (
        <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : !data || data.logs.length === 0 ? (
        <Card><CardContent className="p-6 text-center text-xs text-muted-foreground">لاگی ثبت نشده است</CardContent></Card>
      ) : (
        <div className="space-y-2 max-h-[60vh] overflow-y-auto">
          {data.logs.map((l) => (
            <Card key={l.id}>
              <CardContent className="p-3 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-bold flex items-center gap-1.5">
                    <Eye className="h-3 w-3 text-primary" /> {actionLabel(l.action)}
                  </span>
                  <span className="text-[9px] text-muted-foreground">{formatJalaliDateTime(l.createdAt)}</span>
                </div>
                <div className="text-[10px] text-muted-foreground flex items-center gap-3 flex-wrap">
                  {l.actorName && <span>توسط: {l.actorName}</span>}
                  {l.orgId && <span className="flex items-center gap-1"><Building2 className="h-3 w-3" />{l.orgId.slice(0, 10)}…</span>}
                  {l.ip && <span className="flex items-center gap-1"><Smartphone className="h-3 w-3" />{toFa(l.ip)}</span>}
                </div>
                {l.detail && <div className="text-[9px] text-muted-foreground">{l.detail}</div>}
              </CardContent>
            </Card>
          ))}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-1">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>قبلی</Button>
              <span className="text-[10px] text-muted-foreground">{toFa(page)} از {toFa(totalPages)}</span>
              <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>بعدی</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
