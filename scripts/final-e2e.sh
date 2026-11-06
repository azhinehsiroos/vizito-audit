#!/usr/bin/env bash
# =============================================================================
# VIZITO — تست جامع نهایی v2.0 SaaS (دو سرور مستقل با دیتابیس موقت)
#   سرور A (بدون مالک): ثبت‌نام آزاد ← مجموعه مستقل + تریال ۲۴ساعته مجموعه، جداسازی کامل
#     مجموعه‌ها، نقش‌ها (ORG_ADMIN/VISITOR)، قفل لایسنس مجموعه، لایسنس دائمی، D2 (هیچ حذف خودکار)
#   سرور B (با مالک):   سازنده SUPER_ADMIN، دفتر فروش، شارژ، پیام‌ها، چرخه حیات
#   سناریوهای ثبت‌نام اولیه: بدون کلید، کلید غلط، تکراری، سوءاستفاده از توکن،
#     مالک بدون/با کلید غلط، بازسازی مالک (هرگز مالک دوم)، بهداشت لاگ کلیدها
# -----------------------------------------------------------------------------
# اجرا: بعد از «bun run build» →  bash scripts/final-e2e.sh
# هیچ داده‌ای از دیتابیس اصلی تغییر نمی‌کند؛ همه مقادیر حساس هنگام اجرا تصادفی‌اند
# =============================================================================
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
TMP="$(mktemp -d /tmp/vizito-final-e2e.XXXXXX)"
kill_port() { # کشتن فرایند شنوندهٔ پورت (پروسه next-server rename می‌شود — pkill کافی نیست)
  local PID
  PID=$(ss -tlnp 2>/dev/null | grep ":$1 " | grep -oP 'pid=\K[0-9]+' | head -1)
  [ -n "$PID" ] && kill -9 "$PID" 2>/dev/null
  return 0
}
kill_port 3100; kill_port 3101; kill_port 3102; sleep 1
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✔ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ✘ $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — expected=[$2] actual=[$3]"; fi; }
contains() { case "$3" in *"$2"*) ok "$1" ;; *) bad "$1 — needle=[$2] in=[${3:0:160}]" ;; esac; }
jget() { printf '%s' "$1" | python3 -c "import sys,json;d=json.load(sys.stdin);print($2)" 2>/dev/null || echo "(parse-error)"; }

SETUP_TOKEN="$(openssl rand -hex 12)"
OWNER_SETUP_KEY="$(openssl rand -hex 12)"
OWNER_MOBILE="0912$(shuf -i 1000000-9999999 -n 1)"
ADMIN_MOBILE="0913$(shuf -i 1000000-9999999 -n 1)"
STAFF_MOBILE="0914$(shuf -i 1000000-9999999 -n 1)"
STAFF2_MOBILE="0916$(shuf -i 1000000-9999999 -n 1)"
PUBLIC_MOBILE="0915$(shuf -i 1000000-9999999 -n 1)"
PASSWORD="E2e-$(openssl rand -hex 6)-!a1"

openssl genpkey -algorithm ED25519 -out "$TMP/lic.pem" 2>/dev/null
openssl pkey -in "$TMP/lic.pem" -pubout -out "$TMP/licpub.pem" 2>/dev/null
export LICENSE_PRIVATE_KEY_PEM="$(cat "$TMP/lic.pem")"
export LICENSE_PUBLIC_KEY_PEM="$(cat "$TMP/licpub.pem")"
export BACKUP_ENCRYPTION_KEY="$(openssl rand -base64 48)"
export SETUP_TOKEN OWNER_SETUP_KEY

sign_key() { # <name> <mobile> <expiry_ms> <installId>   (e=0 ⇒ دائمی)
  node -e '
const crypto=require("crypto");
const [name,mobile,e,installId]=process.argv.slice(1);
const b64=(b)=>b.toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const payload={v:2,n:String(name).slice(0,80),m:String(mobile).slice(0,20),e:Number(e),i:String(installId).slice(0,40)};
const body=b64(Buffer.from(JSON.stringify(payload),"utf8"));
const sig=b64(crypto.sign(null,Buffer.from(body),crypto.createPrivateKey(process.env.LICENSE_PRIVATE_KEY_PEM)));
console.log("VZT2."+body+"."+sig);
' "$1" "$2" "$3" "$4"
}

sign_key3() { # <orgId> <expiry_ms>   (e=0 ⇒ دائمی) — کلید VZT3 لایسنس مجموعه
  node -e '
const crypto=require("crypto");
const [o,e]=process.argv.slice(1);
const b64=(b)=>b.toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const payload={v:3,o:String(o),e:Number(e)};
const body=b64(Buffer.from(JSON.stringify(payload),"utf8"));
const sig=b64(crypto.sign(null,Buffer.from(body),crypto.createPrivateKey(process.env.LICENSE_PRIVATE_KEY_PEM)));
console.log("VZT3."+body+"."+sig);
' "$1" "$2"
}

start_server() { # start_server <name> <port> <db> <extra-env...>
  local name=$1 port=$2 db=$3; shift 3
  DATABASE_URL="file:$db" node scripts/migrate-sqlite.cjs >/dev/null 2>&1 || { bad "migrations $name"; return 1; }
  env DATABASE_URL="file:$db" PORT="$port" HOSTNAME=127.0.0.1 \
      VIZITO_DATA_DIR="$TMP/$name-data" "$@" \
      node .next/standalone/server.js >"$TMP/$name.log" 2>&1 &
  echo $!
}

wait_up() { # <port>
  for _ in $(seq 1 60); do
    curl -s --max-time 2 "http://127.0.0.1:$1/api/auth/status" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

cj() { echo "$TMP/cookie-$1.txt"; }
rq() { # rq <port> <user> <METHOD> <path> [json]
  local S=$1 u=$2 m=$3 p=$4 d=${5:-}
  if [ -n "$d" ]; then
    curl -s --max-time 15 -X "$m" -b "$(cj "$u")" -c "$(cj "$u")" -H 'Content-Type: application/json' -d "$d" "http://127.0.0.1:$S$p"
  else
    curl -s --max-time 15 -X "$m" -b "$(cj "$u")" -c "$(cj "$u")" -H 'Content-Type: application/json' "http://127.0.0.1:$S$p"
  fi
}
code() { # code <port> <user> <METHOD> <path> [json]
  local S=$1 u=$2 m=$3 p=$4 d=${5:-}
  curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X "$m" -b "$(cj "$u")" -c "$(cj "$u")" -H 'Content-Type: application/json' ${d:+-d "$d"} "http://127.0.0.1:$S$p"
}

# ===========================================================================
echo "############ سرور A — بدون مالک (چرخه حیات) ############"
DBA="$TMP/a.db"
A_PID=$(start_server a 3100 "$DBA") || exit 1
wait_up 3100 && ok "سرور A آماده شد" || { bad "سرور A بالا نیامد"; tail -15 "$TMP/a.log"; exit 1; }

XFF_REG() { # XFF_REG <port> <xff-ip> <json> — ثبت‌نام با IP متمایز (سهمیه نرخ مستقل برای هر سناریو)
  curl -s --max-time 15 -H 'Content-Type: application/json' -H "X-Forwarded-For: $2" -d "$3" "http://127.0.0.1:$1/api/auth/register"
}

echo "== ۰) سناریوهای امنیتی ثبت‌نام اولیه (نصب تازه) =="
# شماره متمایز برای سناریوهای منفی — سهمیه reg-m هر شماره (۳ در ۱۰ دقیقه) مصرف نشود
NEG_MOBILE="0917$(shuf -i 1000000-9999999 -n 1)"
R=$(XFF_REG 3100 198.51.100.11 "{\"mobile\":\"$NEG_MOBILE\",\"name\":\"بدون کلید\",\"password\":\"$PASSWORD\"}")
contains "ثبت‌نام اولین مدیر بدون SETUP_TOKEN رد شد (403)" "SETUP_TOKEN_REQUIRED" "$R"
R=$(XFF_REG 3100 198.51.100.12 "{\"mobile\":\"$NEG_MOBILE\",\"name\":\"کلید غلط\",\"password\":\"$PASSWORD\",\"setupToken\":\"wrong-token-xyz\"}")
contains "ثبت‌نام با SETUP_TOKEN نادرست رد شد (403)" "SETUP_TOKEN_REQUIRED" "$R"

echo "== ۱) نصب تازه + اولین مدیر + ترِیال ۲۴ ساعته =="
check "نصب تازه شناسایی شد" "True" "$(jget "$(curl -s http://127.0.0.1:3100/api/license/status)" "d['freshInstall']")"
R=$(rq 3100 none POST /api/auth/register "{\"mobile\":\"$ADMIN_MOBILE\",\"name\":\"مدیر خریدار\",\"company\":\"مجموعه اصلی\",\"password\":\"$PASSWORD\",\"setupToken\":\"$SETUP_TOKEN\"}")
check "ثبت‌نام اولین مدیر → ORG_ADMIN" "ORG_ADMIN" "$(jget "$R" "d['user']['role']")"
check "ثبت‌نام اولین مدیر مجموعه ساخت (orgId)" "True" "$(jget "$R" "bool(d.get('orgId'))")"
check "ترِیال ۲۴ساعته در پاسخ ثبت‌نام هست" "True" "$(jget "$R" "d.get('trialEndsAt') is not None")"
rq 3100 admin POST /api/auth/login "{\"mobile\":\"$ADMIN_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null
R=$(rq 3100 admin GET /api/auth/me)
ADMIN_ORG=$(jget "$R" "d['org']['id']")
check "داخل تریال مجموعه: licenseLocked=false" "False" "$(jget "$R" "d['licenseLocked']")"
check "مدیر مجموعه به مدیریت کاربران دسترسی دارد" "True" "$(jget "$R" "'users' in d['sections']")"

C=$(XFF_REG 3100 198.51.100.13 "{\"mobile\":\"$ADMIN_MOBILE\",\"name\":\"تکراری\",\"password\":\"$PASSWORD\",\"setupToken\":\"$SETUP_TOKEN\"}")
contains "ثبت‌نام تکراری همان شماره (حتی با SETUP_TOKEN درست) → 409" "ثبت‌نام انجام نشد" "$C"
EXPL_MOBILE="0915$(shuf -i 1000000-9999999 -n 1)"
R=$(XFF_REG 3100 198.51.100.14 "{\"mobile\":\"$EXPL_MOBILE\",\"name\":\"سوءاستفاده از توکن\",\"password\":\"$PASSWORD\",\"setupToken\":\"$SETUP_TOKEN\"}")
check "SETUP_TOKEN پس از اولین ثبت‌نام مدیر نمی‌سازد (ORG_ADMIN مجموعه جدا)" "ORG_ADMIN" "$(jget "$R" "d['user']['role']")"
check "حساب سوءاستفاده‌کننده مجموعه مستقل گرفت" "True" "$(jget "$R" "bool(d.get('orgId')) and d.get('orgId') != '$ADMIN_ORG'")"
check "حساب سوءاستفاده‌کننده با همان شماره ساخته شد (ثبت‌نام آزاد)" "$EXPL_MOBILE" "$(jget "$R" "d['user']['mobile']")"

echo "== ۲) ثبت‌نام آزاد با کد دعوت → مجموعه مستقل با تریال (SaaS) =="
rq 3100 admin POST /api/settings/invite '{}' >/dev/null
INVITE=$(jget "$(rq 3100 admin GET /api/settings)" "d['inviteCode']")
R=$(rq 3100 none POST /api/auth/register "{\"mobile\":\"$PUBLIC_MOBILE\",\"name\":\"مدیر مجموعه دوم\",\"company\":\"مجموعه دوم\",\"password\":\"$PASSWORD\",\"inviteCode\":\"$INVITE\"}")
check "ثبت‌نام آزاد با کد دعوت → ORG_ADMIN" "ORG_ADMIN" "$(jget "$R" "d['user']['role']")"
rq 3100 public POST /api/auth/login "{\"mobile\":\"$PUBLIC_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null
R=$(rq 3100 public GET /api/auth/me)
check "kind=STAFF" "STAFF" "$(jget "$R" "d['user']['kind']")"
check "تریال مجموعه خودش فعال است (trialEndsAt)" "True" "$(jget "$R" "d['org']['trialEndsAt'] is not None")"
check "مدیر مجموعه به مدیریت کاربران دسترسی دارد" "True" "$(jget "$R" "'users' in d['sections']")"
C=$(code 3100 public POST /api/customers '{"name":"مشتری مجموعه دوم","phone":"09160000001","type":"STORE"}')
check "مدیر مجموعه در تریال مشتری می‌سازد" "201" "$C"

echo "== ۲٫۵) ثبت‌نام آزاد — بدون کد دعوت و بدون توکن (ممیزی v1.1.4) =="
FREE_MOBILE="0935$(shuf -i 1000000-9999999 -n 1)"
R=$(XFF_REG 3100 198.51.100.21 "{\"mobile\":\"$FREE_MOBILE\",\"name\":\"کاربر آزاد\",\"password\":\"$PASSWORD\"}")
check "ثبت‌نام آزاد بدون کد دعوت/توکن → ORG_ADMIN" "ORG_ADMIN" "$(jget "$R" "d['user']['role']")"
WRONGI_MOBILE="0936$(shuf -i 1000000-9999999 -n 1)"
C=$(XFF_REG 3100 198.51.100.22 "{\"mobile\":\"$WRONGI_MOBILE\",\"name\":\"کد دعوت غلط\",\"password\":\"$PASSWORD\",\"inviteCode\":\"wrong-invite-xyz\"}")
contains "کد دعوت نادرست رد شد (403)" "کد دعوت واردشده نادرست است" "$C"
R=$(XFF_REG 3100 198.51.100.23 "{\"mobile\":\"$WRONGI_MOBILE\",\"name\":\"کد دعوت درست\",\"password\":\"$PASSWORD\",\"inviteCode\":\"$INVITE\"}")
check "ثبت‌نام با کد دعوت درست همچنان کار می‌کند → ORG_ADMIN" "ORG_ADMIN" "$(jget "$R" "d['user']['role']")"

echo "== ۳) پرسنل با گرنت دائمی =="
R=$(rq 3100 admin POST /api/users "{\"mobile\":\"$STAFF_MOBILE\",\"name\":\"پرسنل فروش\",\"password\":\"$PASSWORD\",\"sections\":[\"customers\",\"orders\",\"dashboard\"],\"durationHours\":null}")
contains "ساخت پرسنل" '"id"' "$R"
rq 3100 staff POST /api/auth/login "{\"mobile\":\"$STAFF_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null
R=$(rq 3100 staff GET /api/auth/me)
check "kind=STAFF" "STAFF" "$(jget "$R" "d['user']['kind']")"
check "گرنت دائمی (grantExpiresAt=null)" "None" "$(jget "$R" "d['grantExpiresAt']")"
C=$(code 3100 staff POST /api/customers '{"name":"مشتری پرسنل","phone":"09160000002","type":"STORE"}')
check "پرسنل مشتری می‌سازد" "201" "$C"
C=$(code 3100 staff GET /api/users)
check "پرسنل به مدیریت کاربران دسترسی ندارد (403)" "403" "$C"

echo "== ۴) غیرفعال/فعال‌سازی پرسنل =="
STAFF_ID=$(jget "$(rq 3100 admin GET /api/users)" "[u['id'] for u in d if u['mobile']=='$STAFF_MOBILE'][0]")
C=$(code 3100 admin PUT "/api/users/$STAFF_ID" '{"disabled":true}')
check "غیرفعال‌سازی حساب" "200" "$C"
C=$(code 3100 none POST /api/auth/login "{\"mobile\":\"$STAFF_MOBILE\",\"password\":\"$PASSWORD\"}")
check "ورود پرسنل غیرفعال رد شد (403)" "403" "$C"
C=$(code 3100 staff GET /api/customers)
check "نشست قبلی پرسنل باطل شد (401)" "401" "$C"
C=$(code 3100 admin PUT "/api/users/$STAFF_ID" '{"disabled":false}')
check "فعال‌سازی مجدد" "200" "$C"
C=$(code 3100 staff POST /api/auth/login "{\"mobile\":\"$STAFF_MOBILE\",\"password\":\"$PASSWORD\"}")
check "ورود پرسنل فعال شد" "200" "$C"

echo "== ۴٫۵) امنیت فاکتور خرید در تسویه‌ها (مجوز purchase_price) =="
# پرسنل فاقد مجوز purchase_price است؛ مدیر (isAdmin) دارای مجوز ضمنی است
CU2=$(jget "$(rq 3100 staff POST /api/customers '{"name":"مشتری تسویه","phone":"09160000003","type":"STORE"}')" "d['id']")
R=$(rq 3100 staff POST /api/orders "{\"customerId\":\"$CU2\",\"priceType\":\"STORE\",\"items\":[{\"productName\":\"کالای پرسنل\",\"quantity\":1,\"price\":12000}]}")
OS2=$(jget "$R" "d['id']")
check "پرسنل فاکتور عادی ثبت کرد" "True" "$(jget "$R" "bool(d['id'])")"
C=$(code 3100 staff PUT "/api/orders/$OS2" '{"priceType":"PURCHASE","items":[{"productName":"کالای پرسنل","quantity":1,"price":12000}]}')
check "ارتقای نوع فاکتور عادی به «خرید» بدون مجوز رد شد (403)" "403" "$C"
C=$(code 3100 staff PUT "/api/orders/$OS2" '{"priceType":"PHARMACY","items":[{"productName":"کالای پرسنل","quantity":1,"price":12000}]}')
check "تغییر نوع فاکتور به «دارویی» بدون مجوز خرید همچنان مجاز است (200)" "200" "$C"
C=$(code 3100 staff PUT "/api/orders/$OS2" '{"priceType":"STORE","items":[{"productName":"کالای پرسنل","quantity":1,"price":12000}]}')
check "بازگرداندن نوع فاکتور به «فروشگاهی» (200)" "200" "$C"
R=$(rq 3100 admin POST /api/orders "{\"customerId\":\"$CU2\",\"priceType\":\"PURCHASE\",\"title\":\"فاکتور خرید\",\"items\":[{\"productName\":\"کالای خرید\",\"quantity\":2,\"price\":50000}]}")
OP=$(jget "$R" "d['id']")
check "مدیر فاکتور خرید ثبت کرد (۱۰۰هزار)" "True" "$(jget "$R" "d['priceType']=='PURCHASE' and bool(d['id'])")"
R=$(rq 3100 admin POST /api/orders "{\"customerId\":\"$CU2\",\"priceType\":\"STORE\",\"items\":[{\"productName\":\"کالای فروشگاهی\",\"quantity\":1,\"price\":30000}]}")
OS=$(jget "$R" "d['id']")
check "مدیر فاکتور عادی ثبت کرد (۳۰هزار)" "True" "$(jget "$R" "bool(d['id'])")"
R=$(rq 3100 admin POST /api/payments "{\"customerId\":\"$CU2\",\"orderId\":\"$OP\",\"type\":\"CASH\",\"amount\":40000}")
PP=$(jget "$R" "d['id']")
check "مدیر تسویه فاکتور خرید ثبت کرد (۴۰هزار)" "True" "$(jget "$R" "bool(d['id'])")"
R=$(rq 3100 admin POST /api/payments "{\"customerId\":\"$CU2\",\"orderId\":\"$OS\",\"type\":\"CASH\",\"amount\":10000}")
PS=$(jget "$R" "d['id']")
check "مدیر تسویه فاکتور عادی ثبت کرد (۱۰هزار)" "True" "$(jget "$R" "bool(d['id'])")"
R=$(rq 3100 admin POST /api/payments "{\"customerId\":\"$CU2\",\"type\":\"RECEIPT\",\"amount\":5000}")
PF=$(jget "$R" "d['id']")
check "مدیر تسویه مستقل از فاکتور ثبت کرد (۵هزار)" "True" "$(jget "$R" "bool(d['id'])")"
R=$(rq 3100 staff GET "/api/payments?customerId=$CU2")
check "تسویه فاکتور خرید برای فاقد مجوز نامرئی است" "False" "$(jget "$R" "str('$PP' in [p['id'] for p in d['payments']])")"
check "تسویه فاکتور عادی برای فاقد مجوز دیده می‌شود" "True" "$(jget "$R" "str('$PS' in [p['id'] for p in d['payments']])")"
check "تسویه مستقل برای فاقد مجوز دیده می‌شود" "True" "$(jget "$R" "str('$PF' in [p['id'] for p in d['payments']])")"
check "تعداد تسویه‌های نمایان فاقد مجوز = ۲" "2" "$(jget "$R" "len(d['payments'])")"
check "جمع پرداخت‌های فاقد مجوز فقط از مجازها (۱۵۰۰۰)" "15000" "$(jget "$R" "int(d['summary']['totalPaid'])")"
check "جمع فاکتورهای فاقد مجوز بدون خرید (۴۲۰۰۰)" "42000" "$(jget "$R" "int(d['summary']['totalOrders'])")"
check "مانده فاقد مجوز = ۲۷۰۰۰" "27000" "$(jget "$R" "int(d['summary']['balance'])")"
C=$(code 3100 staff POST /api/payments "{\"customerId\":\"$CU2\",\"orderId\":\"$OP\",\"type\":\"CASH\",\"amount\":40000}")
check "ثبت تسویه روی فاکتور خرید بدون مجوز رد شد (403)" "403" "$C"
C=$(code 3100 staff POST /api/payments "{\"customerId\":\"$CU2\",\"orderId\":\"$OS\",\"type\":\"CASH\",\"amount\":3000}")
check "ثبت تسویه روی فاکتور عادی توسط فاقد مجوز مجاز است (201)" "201" "$C"
C=$(code 3100 staff POST /api/payments "{\"customerId\":\"$CU2\",\"type\":\"CASH\",\"amount\":2000}")
check "ثبت تسویه مستقل توسط فاقد مجوز مجاز است (201)" "201" "$C"
PS2=$(jget "$(rq 3100 staff GET "/api/payments?customerId=$CU2")" "[p['id'] for p in d['payments'] if p['amount']==3000][0]")
R=$(rq 3100 staff GET "/api/payments?customerId=$CU2")
check "تعداد تسویه‌های نمایان پس از افزودن = ۴" "4" "$(jget "$R" "len(d['payments'])")"
check "جمع پرداخت‌های فاقد مجوز = ۲۰۰۰۰" "20000" "$(jget "$R" "int(d['summary']['totalPaid'])")"
check "مانده فاقد مجوز = ۲۲۰۰۰" "22000" "$(jget "$R" "int(d['summary']['balance'])")"
C=$(code 3100 staff DELETE "/api/payments/$PP")
check "حذف تسویه فاکتور خرید توسط فاقد مجوز ← نامرئی (404)" "404" "$C"
C=$(code 3100 staff DELETE "/api/payments/$PS2")
check "حذف تسویه خودِ ثبت‌کننده روی فاکتور عادی مجاز است (200)" "200" "$C"
R=$(rq 3100 admin GET "/api/payments?customerId=$CU2")
check "مدیر همه تسویه‌ها را می‌بیند = ۴" "4" "$(jget "$R" "len(d['payments'])")"
check "تسویه فاکتور خرید برای مدیر نمایان است" "True" "$(jget "$R" "str('$PP' in [p['id'] for p in d['payments']])")"
check "جمع پرداخت‌های مدیر = ۵۷۰۰۰" "57000" "$(jget "$R" "int(d['summary']['totalPaid'])")"
check "جمع فاکتورهای مدیر (با خرید) = ۱۴۲۰۰۰" "142000" "$(jget "$R" "int(d['summary']['totalOrders'])")"
check "مانده مدیر = ۸۵۰۰۰" "85000" "$(jget "$R" "int(d['summary']['balance'])")"
C=$(code 3100 admin PUT "/api/orders/$OS" '{"priceType":"PURCHASE","items":[{"productName":"کالای فروشگاهی","quantity":1,"price":30000}]}')
check "تغییر نوع فاکتور به «خرید» توسط مدیر (دارای مجوز) مجاز است (200)" "200" "$C"
R=$(rq 3100 staff GET "/api/payments?customerId=$CU2")
check "پس از تغییر نوع، تسویه آن فاکتور برای فاقد مجوز نامرئی شد" "False" "$(jget "$R" "str('$PS' in [p['id'] for p in d['payments']])")"
check "جمع پرداخت‌های فاقد مجوز پس از تغییر نوع = ۷۰۰۰" "7000" "$(jget "$R" "int(d['summary']['totalPaid'])")"
check "جمع فاکتورهای فاقد مجوز پس از تغییر نوع = ۱۲۰۰۰ (خریدها حذف)" "12000" "$(jget "$R" "int(d['summary']['totalOrders'])")"
C=$(code 3100 admin PUT "/api/orders/$OS" '{"priceType":"STORE","items":[{"productName":"کالای فروشگاهی","quantity":1,"price":30000}]}')
check "بازگرداندن نوع فاکتور توسط مدیر (200)" "200" "$C"

echo "== ۴٫۸) جداسازی چندمجموعه‌ای (SaaS) — دو مجموعه کاملاً مستقل =="
ORGA_MOBILE="0938$(shuf -i 1000000-9999999 -n 1)"
R=$(XFF_REG 3100 198.51.100.31 "{\"mobile\":\"$ORGA_MOBILE\",\"name\":\"مدیر مجموعه بی\",\"company\":\"مجموعه بی\",\"password\":\"$PASSWORD\"}")
check "ثبت‌نام مجموعه بی → ORG_ADMIN" "ORG_ADMIN" "$(jget "$R" "d['user']['role']")"
rq 3100 orgb POST /api/auth/login "{\"mobile\":\"$ORGA_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null
ORGA_ID=$(jget "$(rq 3100 orgb GET /api/auth/me)" "d['org']['id']")
check "مجموعه بی مستقل است (orgId متفاوت)" "True" "$(jget "$(rq 3100 admin GET /api/auth/me)" "d['org']['id'] != '$ORGA_ID'")"
# مشتری مجموعه بی برای الف کاملاً نامرئی است (۴۰۴ حتی برای مدیر)
CB=$(jget "$(rq 3100 orgb POST /api/customers '{"name":"مشتری مجموعه بی","phone":"09380000001","type":"STORE"}')" "d['id']")
C=$(code 3100 admin GET "/api/customers/$CB")
check "مشتری مجموعه بی برای مدیر الف ← ۴۰۴" "404" "$C"
R=$(rq 3100 admin GET /api/customers)
check "فهرست مشتریان الف شامل مجموعه بی نیست" "False" "$(jget "$R" "str('$CB' in [c['id'] for c in d])")"
# هیچ عملی روی داده مجموعه دیگر ممکن نیست
CU1_ID=$(jget "$(rq 3100 admin GET /api/customers)" "d[0]['id']")
C=$(code 3100 orgb POST /api/orders "{\"customerId\":\"$CU1_ID\",\"items\":[{\"productName\":\"x\",\"quantity\":1,\"price\":1000}]}")
check "سفارش روی مشتری مجموعه دیگر ← ۴۰۴" "404" "$C"
C=$(code 3100 orgb POST /api/payments "{\"customerId\":\"$CU1_ID\",\"type\":\"CASH\",\"amount\":1000}")
check "تسویه روی مشتری مجموعه دیگر ← ۴۰۴" "404" "$C"
OS_ORGA=$(jget "$(rq 3100 admin GET /api/orders)" "d[0]['id']")
C=$(code 3100 orgb GET "/api/orders/$OS_ORGA")
check "فاکتور مجموعه الف برای بی ← ۴۰۴" "404" "$C"
R=$(rq 3100 orgb GET /api/orders)
check "فهرست فاکتورهای مجموعه بی خالی است" "0" "$(jget "$R" "len(d)")"
# کاتالوگ اختصاصی هر مجموعه (تصمیم D3)
GP=$(jget "$(rq 3100 orgb POST /api/groups '{"name":"گروه مجموعه بی"}')" "d['id']")
PB=$(jget "$(rq 3100 orgb POST /api/products "{\"groupId\":\"$GP\",\"name\":\"کالای مجموعه بی\",\"priceStore\":5000}")" "d['id']")
R=$(rq 3100 admin GET /api/products)
check "کالای مجموعه بی برای الف دیده نمی‌شود" "False" "$(jget "$R" "str('$PB' in [p['id'] for p in d])")"
R=$(rq 3100 orgb GET /api/products)
check "کاتالوگ مجموعه بی فقط کالای خودش است" "1" "$(jget "$R" "len(d)")"
R=$(rq 3100 admin GET /api/groups)
check "گروه مجموعه بی برای الف دیده نمی‌شود" "False" "$(jget "$R" "str('$GP' in [g['id'] for g in d])")"
# کاربران فقط داخل مجموعه
R=$(rq 3100 admin GET /api/users)
check "کاربران مجموعه بی برای مدیر الف نامرئی" "False" "$(jget "$R" "str('$ORGA_MOBILE' in [u['mobile'] for u in d])")"
R=$(rq 3100 orgb GET /api/users)
check "مدیر مجموعه بی فقط کاربران خودش را می‌بیند" "1" "$(jget "$R" "len(d)")"
R=$(rq 3100 orgb POST /api/users "{\"mobile\":\"$STAFF2_MOBILE\",\"name\":\"پرسنل مجموعه بی\",\"password\":\"$PASSWORD\",\"sections\":[\"customers\"],\"durationHours\":null}")
contains "مدیر مجموعه بی پرسنل می‌سازد" '"id"' "$R"
rq 3100 staffb POST /api/auth/login "{\"mobile\":\"$STAFF2_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null
C=$(code 3100 staffb GET /api/customers)
check "پرسنل مجموعه بی به مجموعه خودش دسترسی دارد (200)" "200" "$C"
R=$(rq 3100 staffb GET /api/customers)
check "مشتری‌های مجموعه الف برای پرسنل بی نامرئی است" "0" "$(jget "$R" "len(d)")"
# اعلان کاتالوگ از مرز مجموعه عبور نمی‌کند
rq 3100 orgb POST /api/products "{\"groupId\":\"$GP\",\"name\":\"کالای جدید بی\",\"priceStore\":100}" >/dev/null
R=$(rq 3100 admin GET /api/notifications)
check "تغییر کاتالوگ مجموعه بی برای کاربران الف اعلان نمی‌فرستد" "False" "$(jget "$R" "any('کالای جدید بی' in ((n.get('title') or '')+(n.get('body') or '')) for n in d['notifications'])")"
# بکاپ مجموعه‌ای — هیچ مجموعه‌ای بکاپ مجموعه دیگر را نمی‌بیند
C=$(code 3100 orgb POST /api/backups '{}')
check "مدیر مجموعه بی بکاپ می‌گیرد (200)" "200" "$C"
ORGB_BID=$(jget "$(rq 3100 orgb GET /api/backups)" "d['backups'][0]['id']")
R=$(rq 3100 admin GET /api/backups)
check "بکاپ مجموعه بی برای مدیر الف نامرئی است" "False" "$(jget "$R" "str('$ORGB_BID' in [b['id'] for b in d['backups']])")"
C=$(code 3100 admin DELETE "/api/backups/$ORGB_BID")
check "حذف بکاپ مجموعه بی توسط الف ← ۴۰۴" "404" "$C"
# استقلال تریال — مجموعه بی مستقل از مجموعه اول
R=$(rq 3100 orgb GET /api/auth/me)
check "ترِیال مجموعه بی مستقل است (قفل نیست)" "False" "$(jget "$R" "d['licenseLocked']")"

echo "== ۵) پایان تریال مجموعه اول — قفل مدیر و پرسنل همان مجموعه (سیاست SaaS) =="
node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('$DBA');
const past=new Date(Date.now()-3600_000).toISOString();
// چندمجموعه‌ای: پایان تریال فقط «مجموعه اول» را قفل می‌کند — سایر مجموعه‌ها مستقل‌اند
const r=d.prepare(\"UPDATE Org SET trialEndsAt=? WHERE id=(SELECT orgId FROM User WHERE mobile=?)\").run(past,'$ADMIN_MOBILE');
if (r.changes !== 1) { console.error('org trial update failed'); process.exit(1); }
" >/dev/null
C=$(code 3100 admin GET /api/customers)
check "مدیر بعد از پایان تریال مجموعه قفل شد (402)" "402" "$C"
R=$(rq 3100 admin GET /api/customers)
contains "کد LICENSE_LOCKED" "LICENSE_LOCKED" "$R"
R=$(rq 3100 admin GET /api/auth/me)
check "مدیر قفل است (licenseLocked=true)" "True" "$(jget "$R" "d['licenseLocked']")"
C=$(code 3100 staff GET /api/customers)
check "پرسنل همان مجموعه هم قفل شد (402) — لایسنس سطح مجموعه" "402" "$C"
R=$(rq 3100 orgb GET /api/auth/me)
check "مجموعه بی مستقل از قفل مجموعه اول کار می‌کند" "False" "$(jget "$R" "d['licenseLocked']")"

echo "== ۵٫۵) تریال دقیقاً ۲۴ ساعت مجموعه — مستقل از سایر مجموعه‌ها (SaaS) =="
# مجموعه «کاربر آزاد» (ثبت‌نام بخش ۲٫۵) همچنان در تریال است؛ قفل مجموعه اول اثری بر آن ندارد
rq 3100 free POST /api/auth/login "{\"mobile\":\"$FREE_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null
R=$(rq 3100 free GET /api/auth/me)
check "کاربر آزاد: مدیر مجموعه خودش" "ORG_ADMIN" "$(jget "$R" "d['user']['role']")"
check "کاربر آزاد داخل تریال مجموعه: licenseLocked=false" "False" "$(jget "$R" "d['licenseLocked']")"
T1=$(jget "$R" "d['org']['trialEndsAt']")
C=$(code 3100 free GET /api/customers)
check "داخل تریال مجموعه خودش کار می‌کند (200)" "200" "$C"
C=$(code 3100 free POST /api/customers '{"name":"مشتری کاربر آزاد","phone":"09160000009","type":"STORE"}')
check "کاربر آزاد داخل تریال مشتری می‌سازد (201)" "201" "$C"
# خروج و ورود مجدد تریال را تمدید نمی‌کند (trialEndsAt فقط هنگام ثبت‌نام نوشته می‌شود)
rq 3100 free POST /api/auth/logout '{}' >/dev/null
rq 3100 free POST /api/auth/login "{\"mobile\":\"$FREE_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null
T2=$(jget "$(rq 3100 free GET /api/auth/me)" "d['org']['trialEndsAt']")
check "خروج و ورود مجدد تریال را تمدید نمی‌کند (trialEndsAt ثابت)" "$T1" "$T2"
# پایان تریال فقط همان مجموعه را قفل می‌کند؛ داده‌ها حفظ می‌شوند
node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('$DBA');
d.prepare(\"UPDATE Org SET trialEndsAt=? WHERE id=(SELECT orgId FROM User WHERE mobile=?)\").run(new Date(Date.now()-60000).toISOString(),'$FREE_MOBILE');
" >/dev/null
C=$(code 3100 free GET /api/customers)
check "کاربر آزاد پس از پایان تریال مجموعه‌اش قفل شد (402)" "402" "$C"
R=$(rq 3100 free GET /api/auth/me)
check "کاربر آزاد پس از پایان تریال: licenseLocked=true" "True" "$(jget "$R" "d['licenseLocked']")"
check "اطلاعات کاربر آزاد پس از قفل حفظ شده (حساب موجود)" "True" "$(jget "$R" "d['user']['mobile'] == '$FREE_MOBILE'")"

echo "== ۶) انقضای لایسنس هرگز داده حذف نمی‌کند (تصمیم D2 — سیاست SaaS) =="
INSTALL_ID=$(jget "$(curl -s http://127.0.0.1:3100/api/license/status)" "d['installId']")
K40=$(sign_key "خریدار آزمایشی" "$ADMIN_MOBILE" "$(($(date +%s%3N) - 40*86400000))" "$INSTALL_ID")
# ممیزی v1.1.4 — کلید منقضی برای فعال‌سازی پذیرفته نمی‌شود (منقضی هرگز چرخه حذف را آغاز نمی‌کند)
C=$(code 3100 none POST /api/license/activate "{\"key\":\"$K40\"}")
check "کلید منقضی (۴۰ روز) پذیرفته نمی‌شود (400)" "400" "$C"
R=$(rq 3100 none POST /api/license/activate "{\"key\":\"$K40\"}")
contains "پیام «کد لایسنس منقضی شده است»" "منقضی شده است" "$R"
C=$(code 3100 none POST /api/license/activate '{"key":"VZT2.ZmFrZS1wYXlsb2Fk.ZmFrZS1zaWc"}')
check "کد لایسنس نامعتبر (امضای غلط) رد شد (400)" "400" "$C"
# لایسنس منقضی مستقیماً در DB ثبت می‌شود (کلید امضاشدهٔ معتبر — مکانیزم تست) — سپس پراب تنبل status
node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('$DBA');
d.prepare('INSERT OR REPLACE INTO Setting (key,value,updatedAt) VALUES (?,?,?)').run('license_v1', JSON.stringify({key:process.argv[1],activatedAt:new Date().toISOString()}), new Date().toISOString());
" "$K40" >/dev/null
BEFORE=$(node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('$DBA');
const q=(t)=>d.prepare('SELECT COUNT(*) c FROM \"'+t+'\"').get().c;
console.log(JSON.stringify({customers:q('Customer'),orders:q('Order'),payments:q('Payment'),users:q('User'),orgs:q('Org')}));
")
for _ in $(seq 1 10); do curl -s http://127.0.0.1:3100/api/license/status >/dev/null; sleep 1; done
AFTER=$(node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('$DBA');
const q=(t)=>d.prepare('SELECT COUNT(*) c FROM \"'+t+'\"').get().c;
const log=d.prepare(\"SELECT value FROM Setting WHERE key='data_deleted_at'\").get();
console.log(JSON.stringify({customers:q('Customer'),orders:q('Order'),payments:q('Payment'),users:q('User'),orgs:q('Org'),logExists:!!log}));
")
check "حذف خودکار اجرا نشد (لاگ data_deleted_at نیست — D2)" "False" "$(jget "$AFTER" "d['logExists']")"
check "مشتریان حفظ شدند" "True" "$(jget "$AFTER" "d['customers'] == $(jget "$BEFORE" "d['customers']")")"
check "سفارش‌ها حفظ شدند" "True" "$(jget "$AFTER" "d['orders'] == $(jget "$BEFORE" "d['orders']")")"
check "پرداخت‌ها حفظ شدند" "True" "$(jget "$AFTER" "d['payments'] == $(jget "$BEFORE" "d['payments']")")"
check "کاربران حفظ شدند" "True" "$(jget "$AFTER" "d['users'] == $(jget "$BEFORE" "d['users']")")"
check "مجموعه‌ها حفظ شدند" "True" "$(jget "$AFTER" "d['orgs'] == $(jget "$BEFORE" "d['orgs']")")"

echo "== ۷) مهلت تمدید (لایسنس ۱ روز منقضی در DB — کلید منقضی از API پذیرفته نمی‌شود) =="
K1=$(sign_key "خریدار آزمایشی" "$ADMIN_MOBILE" "$(($(date +%s%3N) - 1*86400000))" "$INSTALL_ID")
C=$(code 3100 none POST /api/license/activate "{\"key\":\"$K1\"}")
check "کلید منقضی ۱ روز هم پذیرفته نمی‌شود (400)" "400" "$C"
node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('$DBA');
d.prepare('INSERT OR REPLACE INTO Setting (key,value,updatedAt) VALUES (?,?,?)').run('license_v1', JSON.stringify({key:process.argv[1],activatedAt:new Date().toISOString()}), new Date().toISOString());
" "$K1" >/dev/null
R=$(curl -s http://127.0.0.1:3100/api/license/status)
check "قفل فعال (valid=false)" "False" "$(jget "$R" "d['valid']")"
check "مهلت تمدید بین ۲۸ تا ۳۰ روز" "True" "$(jget "$R" "28 <= (d['graceDaysLeft'] or 0) <= 30")"
# پس از sweep همه نشست‌ها ابطال شده‌اند — پرسنل (که حسابش حفظ شده) دوباره وارد می‌شود
C=$(code 3100 staff POST /api/auth/login "{\"mobile\":\"$STAFF_MOBILE\",\"password\":\"$PASSWORD\"}")
check "ورود پرسنل پس از sweep (حساب حفظ شده)" "200" "$C"
C=$(code 3100 staff GET /api/customers)
check "انقضای خودِ لایسنس پرسنل را هم قفل می‌کند (402)" "402" "$C"
C=$(code 3100 staff POST /api/auth/login "{\"mobile\":\"$STAFF_MOBILE\",\"password\":\"$PASSWORD\"}")
check "ورود در مهلت تمدید مجاز است" "200" "$C"

echo "== ۸) لایسنس مدت‌دار مجموعه + بازگشت به کار (مسیر لایسنس مجموعه) =="
K30=$(sign_key "خریدار آزمایشی" "$ADMIN_MOBILE" "$(($(date +%s%3N) + 30*86400000))" "$INSTALL_ID")
R=$(rq 3100 none POST /api/license/activate "{\"key\":\"$K30\"}")
check "فعال‌سازی لایسنس ۳۰ روزه (نصب)" "True" "$(jget "$R" "d.get('ok')")"
R=$(curl -s http://127.0.0.1:3100/api/license/status)
check "daysLeft بین ۲۷ تا ۳۱" "True" "$(jget "$R" "27 <= (d['daysLeft'] or 0) <= 31")"
# SaaS: بازگشایی مجموعه اول با ثبت لایسنس مجموعه (معادل صدور از پنل سازنده — فاز ۴)
node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('$DBA');
const orgId=d.prepare(\"SELECT orgId FROM User WHERE mobile=?\").get('$ADMIN_MOBILE').orgId;
if (!orgId) { console.error('admin orgId missing'); process.exit(1); }
const exp=new Date(Date.now()+30*86400000).toISOString();
d.prepare(\"INSERT INTO License (id,orgId,plan,startsAt,expiresAt,status,source,note,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)\").run('lic-org1-'+Date.now(),orgId,'D30',new Date().toISOString(),exp,'ACTIVE','MIGRATION','تست',new Date().toISOString(),new Date().toISOString());
" >/dev/null
C=$(code 3100 staff GET /api/customers)
check "پرسنل بعد از لایسنس مجموعه دوباره کار می‌کند (200)" "200" "$C"
R=$(rq 3100 admin GET /api/auth/me)
check "مدیر مجموعه بعد از لایسنس آزاد است" "False" "$(jget "$R" "d['licenseLocked']")"

echo "== ۹) لایسنس دائمی مجموعه =="
KP=$(sign_key "خریدار دائمی" "$ADMIN_MOBILE" "0" "$INSTALL_ID")
R=$(rq 3100 none POST /api/license/activate "{\"key\":\"$KP\"}")
check "فعال‌سازی دائمی (نصب)" "True" "$(jget "$R" "d.get('ok')")"
R=$(curl -s http://127.0.0.1:3100/api/license/status)
check "دائمی: permanent" "True" "$(jget "$R" "d.get('permanent')")"
check "دائمی: بدون انقضا" "None" "$(jget "$R" "d['expiresAt']")"
KD=$(sign_key "کلید مدت‌دار" "$ADMIN_MOBILE" "$(($(date +%s%3N) + 90*86400000))" "$INSTALL_ID")
C=$(code 3100 none POST /api/license/activate "{\"key\":\"$KD\"}")
check "کلید مدت‌دار بعد از دائمی رد می‌شود (400)" "400" "$C"
# SaaS: ارتقای لایسنس مجموعه اول به دائمی
node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('$DBA');
const orgId=d.prepare(\"SELECT orgId FROM User WHERE mobile=?\").get('$ADMIN_MOBILE').orgId;
d.prepare(\"UPDATE License SET plan='PERM', expiresAt=NULL WHERE orgId=?\").run(orgId);
" >/dev/null
C=$(code 3100 staff GET /api/customers)
check "دائمی: پرسنل مجموعه فعال (200)" "200" "$C"
R=$(rq 3100 admin GET /api/auth/me)
check "دائمی: مجموعه آزاد (licenseLocked=false)" "False" "$(jget "$R" "d['licenseLocked']")"

echo "== ۱۰) امنیت عمومی (سرور A) =="
C=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST -H 'Content-Type: text/plain' -d '{}' "http://127.0.0.1:3100/api/auth/login")
check "ورود با text/plain بلاک (403)" "403" "$C"
C=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST -d '{}' "http://127.0.0.1:3100/api/auth/login")
check "ورود بدون Content-Type بلاک (403)" "403" "$C"
# پس از قفل‌ها — کاربر دارای گرنت نباید به مدیریت کاربران برسد (نشست تازه پرسنل)
rq 3100 staff POST /api/auth/login "{\"mobile\":\"$STAFF_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null
C=$(code 3100 staff GET /api/users)
check "کاربر عادی (پرسنل، نشست تازه) به مدیریت کاربران دسترسی ندارد (403)" "403" "$C"
kill $A_PID 2>/dev/null

# ===========================================================================
echo "############ سرور B — با مالک (امکانات مالک) ############"
OWNER2_MOBILE="0918$(shuf -i 1000000-9999999 -n 1)" # شماره فریبنده برای سناریوهای منفی مالک (هرگز حساب نمی‌سازد)
DBB="$TMP/b.db"
B_PID=$(start_server b 3101 "$DBB" OWNER_MOBILES="$OWNER_MOBILE,$OWNER2_MOBILE") || exit 1
wait_up 3101 && ok "سرور B آماده شد" || { bad "سرور B بالا نیامد"; tail -15 "$TMP/b.log"; exit 1; }

echo "== ۱۰−) سناریوهای امنیتی ثبت‌نام مالک =="
R=$(XFF_REG 3101 198.51.100.21 "{\"mobile\":\"$OWNER2_MOBILE\",\"name\":\"بدون کلید سازنده\",\"password\":\"$PASSWORD\"}")
contains "ثبت‌نام مالک بدون OWNER_SETUP_KEY رد شد (403)" "OWNER_KEY_REQUIRED" "$R"
R=$(XFF_REG 3101 198.51.100.22 "{\"mobile\":\"$OWNER2_MOBILE\",\"name\":\"کلید سازنده غلط\",\"password\":\"$PASSWORD\",\"setupKey\":\"wrong-owner-key-xyz\"}")
contains "ثبت‌نام مالک با کلید نادرست رد شد (403)" "OWNER_KEY_REQUIRED" "$R"

echo "== ۱۱) مالک + پرسنل =="
R=$(rq 3101 none POST /api/auth/register "{\"mobile\":\"$OWNER_MOBILE\",\"name\":\"مالک برنامه\",\"password\":\"$PASSWORD\",\"setupKey\":\"$OWNER_SETUP_KEY\"}")
check "ثبت‌نام مالک → SUPER_ADMIN" "SUPER_ADMIN" "$(jget "$R" "d['user']['role']")"
check "سازنده بدون مجموعه است (orgId=null)" "None" "$(jget "$R" "d.get('orgId')")"
rq 3101 owner POST /api/auth/login "{\"mobile\":\"$OWNER_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null
R=$(rq 3101 owner GET /api/auth/me)
check "isOwner" "True" "$(jget "$R" "d['isOwner']")"
R=$(rq 3101 owner POST /api/users "{\"mobile\":\"$STAFF_MOBILE\",\"name\":\"پرسنل B\",\"password\":\"$PASSWORD\",\"sections\":[\"customers\",\"dashboard\"],\"durationHours\":null}")
contains "ساخت پرسنل توسط مالک" '"id"' "$R"
rq 3101 staff POST /api/auth/login "{\"mobile\":\"$STAFF_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null
rq 3101 owner POST /api/settings/invite '{}' >/dev/null
INVITE=$(jget "$(rq 3101 owner GET /api/settings)" "d['inviteCode']")
rq 3101 none POST /api/auth/register "{\"mobile\":\"$PUBLIC_MOBILE\",\"name\":\"کاربر عمومی B\",\"password\":\"$PASSWORD\",\"inviteCode\":\"$INVITE\"}" >/dev/null
rq 3101 public POST /api/auth/login "{\"mobile\":\"$PUBLIC_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null

echo "== ۱۲) دفتر فروش: صدور مدت‌دار/دائمی + شارژ + توقف حذف =="
INSTALL_B=$(jget "$(curl -s http://127.0.0.1:3101/api/license/status)" "d['installId']")
R=$(rq 3101 owner POST /api/license/sales "{\"buyerName\":\"خریدار ۱\",\"buyerMobile\":\"$ADMIN_MOBILE\",\"durationDays\":30,\"installId\":\"$INSTALL_B\"}")
contains "صدور لایسنس ۳۰ روزه" '"key"' "$R"
SALE1=$(jget "$(rq 3101 owner GET /api/license/sales)" "[s['id'] for s in d['sales'] if not s.get('permanent')][0]")
EXP1=$(jget "$(rq 3101 owner GET /api/license/sales/$SALE1)" "d['sale']['expiresAt']")
rq 3101 owner PATCH "/api/license/sales/$SALE1" '{"addDays":30}' >/dev/null
EXP2=$(jget "$(rq 3101 owner GET /api/license/sales/$SALE1)" "d['sale']['expiresAt']")
DIFF_S=$(( $(date -u -d "$EXP2" +%s) - $(date -u -d "$EXP1" +%s) ))
check "تمدید زودهنگام = +۳۰ روز دقیق" "True" "$( [ $DIFF_S -ge 2591400 ] && [ $DIFF_S -le 2592600 ] && echo True || echo False )"
R=$(rq 3101 owner POST /api/license/sales "{\"buyerName\":\"خریدار دائمی\",\"buyerMobile\":\"$ADMIN_MOBILE\",\"durationDays\":0,\"installId\":\"$INSTALL_B\"}")
check "صدور لایسنس دائمی" "True" "$(jget "$R" "(d.get('sale') or {}).get('permanent')")"
PERM_SALE=$(jget "$(rq 3101 owner GET /api/license/sales)" "[s['id'] for s in d['sales'] if s.get('permanent')][0]")
C=$(code 3101 owner PATCH "/api/license/sales/$PERM_SALE" '{"addDays":30}')
check "شارژ دائمی رد می‌شود (400)" "400" "$C"
C=$(code 3101 owner PATCH "/api/license/sales/$SALE1" '{"pauseDeletion":true}')
check "توقف حذف خودکار روی فروش" "200" "$C"
R=$(rq 3101 owner GET /api/license/sales)
check "پرچم توقف حذف ثبت شد" "True" "$(jget "$R" "[s.get('pauseDeletion') for s in d['sales'] if s['id']=='$SALE1'][0]")"
C=$(code 3101 staff POST /api/license/sales "{\"buyerName\":\"x\",\"buyerMobile\":\"09120000001\",\"durationDays\":30,\"installId\":\"$INSTALL_B\"}")
check "غیرمالک نمی‌تواند لایسنس صادر کند (403)" "403" "$C"

echo "== ۱۳) پیام‌ها و اطلاع‌رسانی =="
R=$(rq 3101 owner POST /api/admin/messages '{"audience":"ALL","title":"خوش آمدید","body":"پیام آزمایشی","important":true}')
CNT=$(jget "$R" "d.get('recipientCount') or 0")
check "ارسال به همه (${CNT} گیرنده ≥ ۲)" "True" "$( [ "${CNT:-0}" -ge 2 ] && echo True || echo False )"
R=$(rq 3101 owner POST /api/admin/messages "{\"audience\":\"SALE_EXPIRED\",\"title\":\"تمدید کنید\",\"body\":\"لایسنس شما منقضی شده\"}")
check "مخاطب «لایسنس منقضی» پذیرفته شد یا بدون گیرنده اعلام شد" "True" "$(jget "$R" "('recipientCount' in d) or ('error' in d)")"
R=$(rq 3101 staff GET /api/messages)
check "پرسنل پیام گرفت (خوانده‌نشده)" "True" "$(jget "$R" "d['unread'] >= 1 and len(d['messages'])>=1")"
STAFF_RID=$(jget "$R" "d['messages'][0]['id']")
PUB_RID=$(jget "$(rq 3101 public GET /api/messages)" "d['messages'][0]['id']")
C=$(code 3101 staff POST "/api/messages/$PUB_RID/read")
check "خواندن پیام دیگری ممنوع (403)" "403" "$C"
C=$(code 3101 staff POST "/api/messages/$STAFF_RID/read")
check "خواندن پیام خود" "200" "$C"
R=$(rq 3101 owner GET /api/admin/messages)
check "تاریخچه: خوانده‌شدن ثبت شد" "True" "$(jget "$R" "any(m['readCount']>=1 for m in d['messages'])")"
C=$(code 3101 staff POST /api/admin/messages '{"audience":"ALL","title":"x"}')
check "غیرمالک ارسال مدیریتی ممنوع (403)" "403" "$C"
C=$(code 3101 owner DELETE "/api/admin/messages/$(jget "$(rq 3101 owner GET /api/admin/messages)" "d['messages'][0]['id']")")
check "حذف پیام توسط مالک" "200" "$C"
R=$(rq 3101 staff GET /api/messages)
check "پیام حذف‌شده پنهان است" "0" "$(jget "$R" "len([m for m in d['messages'] if m['title']=='خوش آمدید'])")"

echo "== ۱۴) چرخه حیات از دید مالک =="
R=$(rq 3101 owner GET /api/admin/lifecycle)
check "فاز روی سرور مالک = OWNER_UNLOCKED" "OWNER_UNLOCKED" "$(jget "$R" "d['phase']")"
R=$(rq 3101 owner POST /api/admin/lifecycle '{"action":"pause"}')
check "توقف حذف خودکار (کلید سرور)" "True" "$(jget "$R" "d.get('paused')")"
R=$(rq 3101 owner POST /api/admin/lifecycle '{"action":"resume"}')
check "ادامه حذف خودکار" "False" "$(jget "$R" "d.get('paused')")"
C=$(code 3101 staff GET /api/admin/lifecycle)
check "غیرمالک به چرخه حیات دسترسی ندارد (403)" "403" "$C"

echo "== ۱۴−) بازسازی مالک = هرگز مالک دوم ساخته نمی‌شود =="
R=$(rq 3101 none POST /api/auth/register "{\"mobile\":\"$OWNER_MOBILE\",\"name\":\"مالک برنامه\",\"password\":\"$PASSWORD\",\"setupKey\":\"$OWNER_SETUP_KEY\"}")
check "ثبت‌نام مجدد مالک با کلید درست → ارتقای همان حساب (upgraded)" "True" "$(jget "$R" "d.get('upgraded')")"
rq 3101 owner POST /api/auth/login "{\"mobile\":\"$OWNER_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null
R=$(rq 3101 owner GET /api/auth/me)
check "نشست تازه مالک پس از ارتقا برقرار است (isOwner)" "True" "$(jget "$R" "d['isOwner']")"
R=$(rq 3101 owner GET /api/users)
check "فقط یک حساب با شماره مالک وجود دارد (مالک دوم ساخته نشد)" "1" "$(jget "$R" "sum(1 for u in d if u['mobile']=='$OWNER_MOBILE')")"

echo "== ۱۴٫۵) لایسنس مستقل مجموعه — VZT3 + صدور/تمدید/تعلیق (SaaS) =="
ORGT_MOBILE="0939$(shuf -i 1000000-9999999 -n 1)"
R=$(XFF_REG 3101 198.51.100.41 "{\"mobile\":\"$ORGT_MOBILE\",\"name\":\"مدیر مجموعه لایسنس\",\"company\":\"مجموعه لایسنس\",\"password\":\"$PASSWORD\"}")
check "ثبت‌نام مجموعه آزمون → ORG_ADMIN" "ORG_ADMIN" "$(jget "$R" "d['user']['role']")"
rq 3101 orgh POST /api/auth/login "{\"mobile\":\"$ORGT_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null
ORGT_ID=$(jget "$(rq 3101 orgh GET /api/auth/me)" "d['org']['id']")
R=$(rq 3101 orgh GET /api/license/status)
check "وضعیت لایسنس مجموعه‌ای است (org.id)" "$ORGT_ID" "$(jget "$R" "d['org']['id']")"
check "ترِیال مجموعه: valid=true" "True" "$(jget "$R" "d['valid']")"
# مجموعه کنترل — تریالش بسته می‌شود تا استقلال لایسنس مجموعه‌ها دیده شود
ORGC_MOBILE="0941$(shuf -i 1000000-9999999 -n 1)"
XFF_REG 3101 198.51.100.42 "{\"mobile\":\"$ORGC_MOBILE\",\"name\":\"مدیر مجموعه کنترل\",\"password\":\"$PASSWORD\"}" >/dev/null
rq 3101 orgc POST /api/auth/login "{\"mobile\":\"$ORGC_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null
node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('$DBB');
d.prepare(\"UPDATE Org SET trialEndsAt=? WHERE id=(SELECT orgId FROM User WHERE mobile=?)\").run(new Date(Date.now()-60000).toISOString(),'$ORGC_MOBILE');
" >/dev/null
C=$(code 3101 orgc GET /api/customers)
check "مجموعه کنترل با تریال بسته قفل است (402)" "402" "$C"
# صدور مستقیم D30 توسط سازنده
R=$(rq 3101 owner POST /api/sa/license "{\"action\":\"issue\",\"orgId\":\"$ORGT_ID\",\"plan\":\"D30\"}")
check "صدور مستقیم لایسنس ۳۰ روزه توسط سازنده" "True" "$(jget "$R" "d.get('ok')")"
R=$(rq 3101 orgh GET /api/license/status)
check "پس از صدور: valid=true" "True" "$(jget "$R" "d['valid']")"
check "پس از صدور: daysLeft بین ۲۸ و ۳۱" "True" "$(jget "$R" "28 <= (d['daysLeft'] or 0) <= 31")"
C=$(code 3101 orgc GET /api/customers)
check "لایسنس مجموعه آزمون اثری بر مجموعه کنترل ندارد (402)" "402" "$C"
# کلید VZT3 D90 — فعال‌سازی سمت مشتری
R=$(rq 3101 owner POST /api/sa/license "{\"action\":\"issueKey\",\"orgId\":\"$ORGT_ID\",\"plan\":\"D90\"}")
KEY90=$(jget "$R" "d['key']")
contains "تولید کلید VZT3" "VZT3." "$KEY90"
C=$(code 3101 none POST /api/license/activate "{\"key\":\"$KEY90\"}")
check "فعال‌سازی کلید VZT3 (200)" "200" "$C"
R=$(rq 3101 orgh GET /api/license/status)
check "پس از فعال‌سازی D90: daysLeft بین ۸۸ و ۹۲" "True" "$(jget "$R" "88 <= (d['daysLeft'] or 0) <= 92")"
C=$(code 3101 none POST /api/license/activate "{\"key\":\"$KEY90\"}")
check "استفاده مجدد از همان کلید رد شد (400)" "400" "$C"
# ضد تنزیل — کلید کوتاه‌تر
R=$(rq 3101 owner POST /api/sa/license "{\"action\":\"issueKey\",\"orgId\":\"$ORGT_ID\",\"plan\":\"D30\"}")
KEYS30=$(jget "$R" "d['key']")
R=$(rq 3101 none POST /api/license/activate "{\"key\":\"$KEYS30\"}")
contains "کلید کوتاه‌تر رد شد (ضد تنزیل)" "جدیدتر از لایسنس فعلی نیست" "$R"
# کلید منقضی VZT3
KEYEXP=$(sign_key3 "$ORGT_ID" "$(($(date +%s%3N) - 5000))")
R=$(rq 3101 none POST /api/license/activate "{\"key\":\"$KEYEXP\"}")
contains "کلید منقضی VZT3 رد شد" "منقضی شده است" "$R"
# تمدید زودهنگام +۳۰ روز
EXP1=$(jget "$(rq 3101 owner GET "/api/sa/license?orgId=$ORGT_ID")" "d['license']['expiresAt']")
R=$(rq 3101 owner POST /api/sa/license "{\"action\":\"extend\",\"orgId\":\"$ORGT_ID\",\"days\":30}")
check "تمدید زودهنگام +۳۰ روز" "True" "$(jget "$R" "d.get('ok')")"
EXP2=$(jget "$(rq 3101 owner GET "/api/sa/license?orgId=$ORGT_ID")" "d['license']['expiresAt']")
DIFF_S=$(( $(date -u -d "$EXP2" +%s) - $(date -u -d "$EXP1" +%s) ))
check "تمدید دقیقاً +۳۰ روز" "True" "$( [ $DIFF_S -ge 2591400 ] && [ $DIFF_S -le 2592600 ] && echo True || echo False )"
# تعلیق
R=$(rq 3101 owner POST /api/sa/license "{\"action\":\"suspend\",\"orgId\":\"$ORGT_ID\",\"note\":\"تست تعلیق\"}")
check "تعلیق مجموعه" "True" "$(jget "$R" "d.get('ok')")"
C=$(code 3101 orgh GET /api/customers)
check "مجموعه تعلیق‌شده قفل شد (402)" "402" "$C"
R=$(rq 3101 orgh GET /api/license/status)
check "فاز قفل = SUSPENDED" "SUSPENDED" "$(jget "$R" "d['phase']")"
check "نشان تعلیق در وضعیت" "True" "$(jget "$R" "d['orgSuspended']")"
# فعال‌سازی کلید در حالت تعلیق رد می‌شود (رفع تعلیق فقط از سمت سازنده)
R=$(rq 3101 owner POST /api/sa/license "{\"action\":\"issueKey\",\"orgId\":\"$ORGT_ID\",\"plan\":\"D365\"}")
KEYY=$(jget "$R" "d['key']")
R=$(rq 3101 none POST /api/license/activate "{\"key\":\"$KEYY\"}")
contains "فعال‌سازی کلید در تعلیق رد می‌شود" "متوقف شده است" "$R"
# فعال‌سازی مجدد
R=$(rq 3101 owner POST /api/sa/license "{\"action\":\"resume\",\"orgId\":\"$ORGT_ID\"}")
check "رفع تعلیق" "True" "$(jget "$R" "d.get('ok')")"
C=$(code 3101 orgh GET /api/customers)
check "پس از رفع تعلیق کار می‌کند (200)" "200" "$C"
C=$(code 3101 none POST /api/license/activate "{\"key\":\"$KEYY\"}")
check "پس از رفع تعلیق کلید معتبر فعال می‌شود (200)" "200" "$C"
# سوابق
R=$(rq 3101 owner GET "/api/sa/license?orgId=$ORGT_ID")
check "سابقه: ISSUE ثبت شده" "True" "$(jget "$R" "any(e['type']=='ISSUE' for e in d['events'])")"
check "سابقه: ACTIVATE ثبت شده" "True" "$(jget "$R" "any(e['type']=='ACTIVATE' for e in d['events'])")"
check "سابقه: EXTEND +۳۰ روز ثبت شده" "True" "$(jget "$R" "any(e['type']=='EXTEND' and e['days']==30 for e in d['events'])")"
check "سابقه: SUSPEND و RESUME ثبت شده" "True" "$(jget "$R" "any(e['type']=='SUSPEND' for e in d['events']) and any(e['type']=='RESUME' for e in d['events'])")"
# دسترسی غیرسازنده
C=$(code 3101 orgh POST /api/sa/license "{\"action\":\"suspend\",\"orgId\":\"$ORGT_ID\"}")
check "غیرسازنده به مدیریت لایسنس دسترسی ندارد (403)" "403" "$C"
C=$(code 3101 orgh GET "/api/sa/license")
check "مشاهده فهرست لایسنس‌ها فقط سازنده (403)" "403" "$C"
# حسابرسی دسترسی سازنده در دیتابیس
AL=$(node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('$DBB');
const n=d.prepare(\"SELECT COUNT(*) c FROM AdminAccessLog WHERE orgId=? AND action IN ('ISSUE_LICENSE','ISSUE_LICENSE_KEY','EXTEND_LICENSE','SUSPEND_ORG','RESUME_ORG','VIEW_LICENSE')\").get('$ORGT_ID').c;
console.log(n);
")
check "حسابرسی دسترسی سازنده ثبت شد (≥۹ ردیف)" "True" "$( [ "${AL:-0}" -ge 9 ] && echo True || echo False )"

echo "== ۱۴٫۶) پنل مدیریت کل — /api/sa/orgs + /api/sa/access-logs (فقط-مشاهده) =="
# فهرست مجموعه‌ها
R=$(rq 3101 owner GET "/api/sa/orgs")
check "فهرست مجموعه‌ها برای سازنده (200)" "True" "$(jget "$R" "any(o['id']=='$ORGT_ID' for o in d['orgs'])")"
check "خلاصه فهرست: تعداد ≥۲ مجموعه" "True" "$(jget "$R" "d['summary']['total']>=2")"
check "رکورد شامل وضعیت مشتق لایسنس" "True" "$(jget "$R" "any(o['licenseState'] in ('ACTIVE','TRIAL','EXPIRED','SUSPENDED','NONE') for o in d['orgs'])")"
check "مدیر مجموعه در فهرست دیده می‌شود" "True" "$(jget "$R" "any((o['admin'] or {}).get('mobile')=='$ORGT_MOBILE' for o in d['orgs'])")"
# فیلترها
R=$(rq 3101 owner GET "/api/sa/orgs?q=$(python3 -c "import urllib.parse;print(urllib.parse.quote('مجموعه لایسنس'))")")
check "جست‌وجوی نام مجموعه کار می‌کند" "True" "$(jget "$R" "any(o['id']=='$ORGT_ID' for o in d['orgs'])")"
R=$(rq 3101 owner GET "/api/sa/orgs?q=$ORGT_MOBILE")
check "جست‌وجوی موبایل مدیر مجموعه" "$ORGT_ID" "$(jget "$R" "d['orgs'][0]['id'] if d['orgs'] else 'x'")"
R=$(rq 3101 owner GET "/api/sa/orgs?license=ACTIVE")
check "فیلتر لایسنس فعال شامل مجموعه لایسندار" "True" "$(jget "$R" "any(o['id']=='$ORGT_ID' for o in d['orgs'])")"
R=$(rq 3101 owner GET "/api/sa/orgs?page=1&pageSize=1")
check "صفحه‌بندی: pageSize=1 → یک ردیف" "1" "$(jget "$R" "len(d['orgs'])")"
# جزئیات — تب‌های فقط-مشاهده (سازنده داده مجموعه آزمون را می‌بیند)
R=$(rq 3101 owner GET "/api/sa/orgs?orgId=$ORGT_ID&tab=overview")
check "تب خلاصه: اطلاعات مجموعه" "مجموعه لایسنس" "$(jget "$R" "d['org']['name']")"
check "تب خلاصه: شمارش کاربران ≥۱" "True" "$(jget "$R" "d['counts']['users']>=1")"
check "تب خلاصه: مدیر مجموعه" "$ORGT_MOBILE" "$(jget "$R" "(d['admin'] or {}).get('mobile','x')")"
R=$(rq 3101 owner GET "/api/sa/orgs?orgId=$ORGT_ID&tab=users")
check "تب کاربران: فهرست بدون هش رمز" "True" "$(jget "$R" "all('password' not in (u or {}) for u in d['users'])")"
check "تب کاربران: نقش ORG_ADMIN دیده می‌شود" "ORG_ADMIN" "$(jget "$R" "[u['role'] for u in d['users'] if u['mobile']=='$ORGT_MOBILE'][0]")"
R=$(rq 3101 owner GET "/api/sa/orgs?orgId=$ORGT_ID&tab=products")
check "تب کالا: پاسخ ساختاریافته" "True" "$(jget "$R" "'groups' in d and 'products' in d")"
R=$(rq 3101 owner GET "/api/sa/orgs?orgId=$ORGT_ID&tab=customers")
check "تب مشتریان: پاسخ ساختاریافته" "True" "$(jget "$R" "'customers' in d")"
R=$(rq 3101 owner GET "/api/sa/orgs?orgId=$ORGT_ID&tab=orders")
check "تب سفارش‌ها: پاسخ ساختاریافته" "True" "$(jget "$R" "'orders' in d")"
R=$(rq 3101 owner GET "/api/sa/orgs?orgId=$ORGT_ID&tab=reports")
check "تب گزارش: جمع فروش عددی" "True" "$(jget "$R" "isinstance(d['totalSales'],(int,float))")"
# جداسازی: داده مجموعه کنترل در جزئیات مجموعه آزمون نیست
R=$(rq 3101 owner GET "/api/sa/orgs?orgId=$ORGT_ID&tab=users")
check "جداسازی: کاربر مجموعه کنترل در جزئیات مجموعه آزمون نیست" "True" "$(jget "$R" "all(u['mobile']!='$ORGC_MOBILE' for u in d['users'])")"
# مجموعه ناموجود = 404 بدون افشا
C=$(code 3101 owner GET "/api/sa/orgs?orgId=nonexistent-org&tab=overview")
check "مجموعه ناموجود → ۴۰۴" "404" "$C"
# دسترسی‌ها
C=$(code 3101 orgh GET "/api/sa/orgs")
check "مدیر مجموعه به پنل مدیریت کل دسترسی ندارد (403)" "403" "$C"
C=$(code 3101 orgh GET "/api/sa/orgs?orgId=$ORGT_ID&tab=users")
check "مدیر مجموعه به جزئیات SA دسترسی ندارد (403)" "403" "$C"
C=$(code 3101 staff GET "/api/sa/orgs?orgId=$ORGT_ID&tab=reports")
check "ویزیتور به پنل SA دسترسی ندارد (403)" "403" "$C"
C=$(code 3101 anon GET "/api/sa/orgs")
check "بدون نشست → ۴۰۱" "401" "$C"
# لاگ دسترسی
R=$(rq 3101 owner GET "/api/sa/access-logs?pageSize=100")
check "لاگ دسترسی برای سازنده (200)" "True" "$(jget "$R" "d['total']>=1")"
check "لاگ: VIEW_ORGS ثبت شده" "True" "$(jget "$R" "any(l['action']=='VIEW_ORGS' for l in d['logs'])")"
check "لاگ: VIEW_USERS ثبت شده" "True" "$(jget "$R" "any(l['action']=='VIEW_USERS' for l in d['logs'])")"
check "لاگ: VIEW_REPORTS ثبت شده" "True" "$(jget "$R" "any(l['action']=='VIEW_REPORTS' for l in d['logs'])")"
check "لاگ: orgId مشاهده ثبت شده" "True" "$(jget "$R" "any(l['orgId']=='$ORGT_ID' for l in d['logs'])")"
C=$(code 3101 orgh GET "/api/sa/access-logs")
check "لاگ دسترسی فقط سازنده (403)" "403" "$C"
R=$(rq 3101 owner GET "/api/sa/access-logs?action=VIEW_ORGS")
check "فیلتر لاگ بر اساس عملیات" "True" "$(jget "$R" "all(l['action']=='VIEW_ORGS' for l in d['logs']) and len(d['logs'])>=1")"

echo "== ۱۴٫۷) پشتیبانی داخلی — /api/support/* + صندوق سازنده (SaaS) =="
uuid4() { python3 -c 'import uuid;print(uuid.uuid4())'; }
# مدیر مجموعه دوم روی سرور B — برای جداسازی بین مجموعه‌ها و تست لیمیت
ORGT2_MOBILE="0938$(shuf -i 1000000-9999999 -n 1)"
R=$(XFF_REG 3101 198.51.100.51 "{\"mobile\":\"$ORGT2_MOBILE\",\"name\":\"مدیر مجموعه دوم B\",\"company\":\"مجموعه دوم B\",\"password\":\"$PASSWORD\"}")
rq 3101 orgh2 POST /api/auth/login "{\"mobile\":\"$ORGT2_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null

# ── ساخت رشته + idempotency با clientRef ──
CR1=$(uuid4)
R=$(rq 3101 orgh POST /api/support/threads "{\"subjectType\":\"RENEW\",\"body\":\"سلام — برای تمدید لایسنس راهنمایی می‌خواهم\",\"clientRef\":\"$CR1\"}")
check "ساخت رشته پشتیبانی (ok)" "True" "$(jget "$R" "d.get('ok')")"
check "وضعیت اولیه OPEN" "OPEN" "$(jget "$R" "d['thread']['status']")"
THREAD_ID=$(jget "$R" "d['thread']['id']")
R=$(rq 3101 orgh POST /api/support/threads "{\"subjectType\":\"RENEW\",\"body\":\"سلام — برای تمدید لایسنس راهنمایی می‌خواهم\",\"clientRef\":\"$CR1\"}")
check "ارسال مجدد همان clientRef = duplicate" "True" "$(jget "$R" "d.get('duplicate')")"
check "همان رشته برمی‌گردد (بدون درج تکراری)" "$THREAD_ID" "$(jget "$R" "d['thread']['id']")"
R=$(rq 3101 orgh GET /api/support/threads)
check "فهرست رشته‌های مجموعه (یکی، بدون نخوانده)" "True" "$(jget "$R" "d['unread']==0 and len(d['threads'])==1")"

# ── اعتبارسنجی ورودی + گیت‌های دسترسی ──
C=$(code 3101 orgh POST /api/support/threads "{\"subjectType\":\"HACK\",\"body\":\"x\"}")
check "موضوع نامعتبر (400)" "400" "$C"
LONGBODY=$(python3 -c 'print("x"*4001)')
C=$(code 3101 orgh POST /api/support/threads "{\"subjectType\":\"GENERAL\",\"body\":\"$LONGBODY\"}")
check "بدنه بلندتر از ۴۰۰۰ (400)" "400" "$C"
C=$(code 3101 orgh POST /api/support/threads "{\"subjectType\":\"GENERAL\",\"body\":\"تست\",\"clientRef\":\"not-a-uuid\"}")
check "clientRef نامعتبر (400)" "400" "$C"
C=$(code 3101 anon GET /api/support/threads)
check "بدون نشست (401)" "401" "$C"
C=$(code 3101 orgh GET /api/sa/support)
check "کاربر مجموعه به صندوق سازنده دسترسی ندارد (403)" "403" "$C"

# ── صندوق سازنده + جست‌وجو/فیلتر ──
R=$(rq 3101 owner GET /api/sa/support)
check "صندوق سازنده رشته را می‌بیند (نخوانده)" "True" "$(jget "$R" "d['summary']['unread']>=1 and any(t['id']=='$THREAD_ID' for t in d['threads'])")"
check "نام مجموعه + مدیر در صندوق" "True" "$(jget "$R" "any(t['org']['name']=='مجموعه لایسنس' and t['org']['admin'] for t in d['threads'])")"
R=$(rq 3101 owner GET "/api/sa/support?q=$ORGT_MOBILE")
check "جست‌وجو با موبایل مدیر" "True" "$(jget "$R" "any(t['id']=='$THREAD_ID' for t in d['threads'])")"
R=$(rq 3101 owner GET "/api/sa/support?unread=1")
check "فیلتر فقط‌نخوانده" "True" "$(jget "$R" "any(t['id']=='$THREAD_ID' for t in d['threads'])")"
R=$(rq 3101 owner GET "/api/sa/support?subject=BUY_LICENSE")
check "فیلتر موضوع نامربوط خالی" "0" "$(jget "$R" "len(d['threads'])")"

# ── پاسخ سازنده + تعیین وضعیت ──
R=$(rq 3101 owner POST "/api/sa/support/$THREAD_ID" "{\"action\":\"reply\",\"body\":\"خوش آمدید — به‌زودی بررسی می‌شود\"}")
check "پاسخ سازنده (ok)" "True" "$(jget "$R" "d.get('ok')")"
VCR=$(uuid4)
rq 3101 owner POST "/api/sa/support/$THREAD_ID" "{\"action\":\"reply\",\"body\":\"پیام دوم\",\"clientRef\":\"$VCR\"}" >/dev/null
R=$(rq 3101 owner POST "/api/sa/support/$THREAD_ID" "{\"action\":\"reply\",\"body\":\"پیام دوم\",\"clientRef\":\"$VCR\"}")
check "پاسخ تکراری سازنده = duplicate" "True" "$(jget "$R" "d.get('duplicate')")"
R=$(rq 3101 owner GET "/api/sa/support?status=ANSWERED")
check "وضعیت ANSWERED پس از پاسخ" "True" "$(jget "$R" "any(t['id']=='$THREAD_ID' for t in d['threads'])")"
R=$(rq 3101 owner GET "/api/sa/support?unread=1")
check "پس از پاسخ، صندوق سازنده خوانده شد" "0" "$(jget "$R" "len(d['threads'])")"

# ── دید مجموعه + خوانده‌شدن خودکار ──
R=$(rq 3101 orgh GET "/api/support/threads/$THREAD_ID")
check "مجموعه هر ۳ پیام را می‌بیند" "3" "$(jget "$R" "len(d['messages'])")"
check "پاسخ جدید مجموعه دیده شد (نشان برداشته شد)" "False" "$(jget "$R" "d['thread']['unreadForOrg']")"
R=$(rq 3101 orgh GET /api/support/threads)
check "فهرست: unread=0 پس از مشاهده" "0" "$(jget "$R" "d['unread']")"

# ── جداسازی مجموعه‌ها (404-masking) ──
C=$(code 3101 orgh2 GET "/api/support/threads/$THREAD_ID")
check "رشته مجموعه دیگر = ۴۰۴" "404" "$C"
R=$(rq 3101 orgh2 GET /api/support/threads)
check "فهرست مجموعه دوم خالی" "0" "$(jget "$R" "len(d['threads'])")"
C=$(code 3101 orgh2 POST "/api/support/threads/$THREAD_ID" "{\"body\":\"نفوذ\"}")
check "ارسال به رشته مجموعه دیگر = ۴۰۴" "404" "$C"

# ── پیام جدید مجموعه ⇒ OPEN + idempotency پیام ──
CR2=$(uuid4)
R=$(rq 3101 orgh POST "/api/support/threads/$THREAD_ID" "{\"body\":\"سؤال بعدی\",\"clientRef\":\"$CR2\"}")
check "ارسال پیام جدید (ok)" "True" "$(jget "$R" "d.get('ok')")"
check "وضعیت به OPEN برگشت" "OPEN" "$(jget "$R" "d['status']")"
R=$(rq 3101 orgh POST "/api/support/threads/$THREAD_ID" "{\"body\":\"سؤال بعدی\",\"clientRef\":\"$CR2\"}")
check "پیام تکراری مجموعه = duplicate" "True" "$(jget "$R" "d.get('duplicate')")"
R=$(rq 3101 orgh GET "/api/support/threads/$THREAD_ID")
check "پیام duplicate درج نشد (۴ پیام)" "4" "$(jget "$R" "len(d['messages'])")"

# ── بستن توسط سازنده + بازگشایی خودکار با پیام مجموعه ──
R=$(rq 3101 owner POST "/api/sa/support/$THREAD_ID" "{\"action\":\"status\",\"status\":\"CLOSED\"}")
check "بستن گفتگو توسط سازنده" "CLOSED" "$(jget "$R" "d['status']")"
R=$(rq 3101 owner POST "/api/sa/support/$THREAD_ID" "{\"action\":\"status\",\"status\":\"CLOSED\"}")
C=$(code 3101 owner POST "/api/sa/support/$THREAD_ID" "{\"action\":\"status\",\"status\":\"CLOSED\"}")
check "تکرار همان وضعیت (400)" "400" "$C"
R=$(rq 3101 orgh POST "/api/support/threads/$THREAD_ID" "{\"body\":\"دوباره سلام — نیاز فوری دارم\",\"clientRef\":\"$(uuid4)\"}")
check "پیام مجموعه روی گفتگوی بسته = بازگشایی خودکار" "OPEN" "$(jget "$R" "d['status']")"

# ── تعلیق مجموعه: فقط پشتیبانی باز می‌ماند (الزام سند) ──
rq 3101 owner POST /api/sa/license "{\"action\":\"suspend\",\"orgId\":\"$ORGT_ID\"}" >/dev/null
C=$(code 3101 orgh GET /api/customers)
check "تعلیق: API تجاری قفل (402)" "402" "$C"
R=$(rq 3101 orgh POST /api/support/threads "{\"subjectType\":\"GENERAL\",\"body\":\"در حالت تعلیق هم پیام می‌رود\"}")
check "تعلیق: پشتیبانی باز است" "True" "$(jget "$R" "d.get('ok')")"
SUS_THREAD=$(jget "$R" "d['thread']['id']")
C=$(code 3101 orgh GET "/api/support/threads/$SUS_THREAD")
check "تعلیق: مشاهده گفتگو آزاد (200)" "200" "$C"
rq 3101 owner POST /api/sa/license "{\"action\":\"resume\",\"orgId\":\"$ORGT_ID\"}" >/dev/null
C=$(code 3101 orgh GET /api/customers)
check "پس از رفع تعلیق API تجاری باز (200)" "200" "$C"

# ── لیمیت پایدار ۱۰/دقیقه (کاربر تازه: orgh2 — یک قبلی + ۱۰ اسپم = ۱۱) ──
for i in $(seq 1 10); do rq 3101 orgh2 POST /api/support/threads "{\"subjectType\":\"GENERAL\",\"body\":\"اسپم $i\",\"clientRef\":\"$(uuid4)\"}" >/dev/null; done
C=$(code 3101 orgh2 POST /api/support/threads "{\"subjectType\":\"GENERAL\",\"body\":\"یازدهم\",\"clientRef\":\"$(uuid4)\"}")
check "لیمیت پشتیبانی ۱۰/دقیقه (429)" "429" "$C"

# ── تنظیمات تماس سازنده (شماره تماس) ──
R=$(rq 3101 owner PUT /api/license/settings "{\"prices\":{\"m1\":\"\",\"m3\":\"\",\"m6\":\"\",\"y1\":\"\",\"perm\":\"\"},\"telegram\":\"vizito_e2e\",\"phone\":\"02112345678\"}")
check "ذخیره شماره تماس سازنده (ok)" "True" "$(jget "$R" "d.get('ok')")"
R=$(rq 3101 none GET /api/license/pricing)
check "شماره تماس در pricing عمومی" "02112345678" "$(jget "$R" "d['phone']")"
C=$(code 3101 orgh PUT /api/license/settings "{\"prices\":{},\"phone\":\"09120000000\"}")
check "تنظیمات فروش فقط سازنده (403)" "403" "$C"

# ── جزئیات از دید سازنده + خوانده‌شدن صندوق ──
R=$(rq 3101 owner GET "/api/sa/support/$THREAD_ID")
check "جزئیات گفتگو برای سازنده (۳ پیام ORG + ۲ VENDOR...)" "True" "$(jget "$R" "len(d['messages'])>=5")"
check "اطلاعات مجموعه در جزئیات" "True" "$(jget "$R" "d['thread']['org']['name']=='مجموعه لایسنس'")"
R=$(rq 3101 owner GET "/api/sa/support?unread=1")
check "پس از مشاهده سازنده، این رشته از نخوانده‌ها خارج شد" "False" "$(jget "$R" "any(t['id']=='$THREAD_ID' for t in d['threads'])")"

# ── حسابرسی پشتیبانی ──
R=$(rq 3101 owner GET "/api/sa/access-logs?action=REPLY_SUPPORT")
check "حسابرسی REPLY_SUPPORT ثبت شد" "True" "$(jget "$R" "d['total']>=1")"
R=$(rq 3101 owner GET "/api/sa/access-logs?action=VIEW_SUPPORT_THREAD")
check "حسابرسی VIEW_SUPPORT_THREAD ثبت شد" "True" "$(jget "$R" "d['total']>=1")"
C=$(code 3101 orgh2 GET "/api/sa/access-logs?action=REPLY_SUPPORT")
check "حسابرسی فقط سازنده (403)" "403" "$C"

echo "== ۱۴٫۸) حالت آفلاین — ثبت دستگاه + پوسته SW/manifest (بخش ۵ سند طراحی) =="
# ثبت دستگاه: هویت فقط شناسه است (نه اعتبارنامه)؛ orgId فقط از نشست سمت سرور
DEV_KEY="e2e-device-$(openssl rand -hex 6)"
# نکته: کوکی‌جرِ «none» روی سرور B نشست مالک را از سناریوهای ثبت‌نام دارد —
# برای آزمون «بدون نشست» از جرِ تازه استفاده می‌شود
C=$(code 3101 noauth POST /api/device "{}")
check "ثبت دستگاه بدون نشست (401)" "401" "$C"
C=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST -b "$(cj orgh)" -c "$(cj orgh)" -H 'Content-Type: application/json' "http://127.0.0.1:3101/api/device")
check "ثبت دستگاه بدون هویت دستگاه (400)" "400" "$C"
C=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST -b "$(cj orgh)" -c "$(cj orgh)" -H 'Content-Type: application/json' -H 'X-Vizito-Device: bad key!' -d '{}' "http://127.0.0.1:3101/api/device")
check "شناسه دستگاه با کاراکتر ناامن (400)" "400" "$C"
C=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST -b "$(cj orgh)" -c "$(cj orgh)" -H 'Content-Type: application/json' -H 'X-Vizito-Device: abc' -d '{}' "http://127.0.0.1:3101/api/device")
check "شناسه دستگاه خیلی کوتاه (400)" "400" "$C"
R=$(curl -s --max-time 15 -X POST -b "$(cj orgh)" -c "$(cj orgh)" -H 'Content-Type: application/json' -H "X-Vizito-Device: $DEV_KEY" -d '{"label":"گوشی ویزیتور آزمون"}' "http://127.0.0.1:3101/api/device")
check "ثبت دستگاه موفق (ok)" "True" "$(jget "$R" "d.get('ok')")"
DEVICE_ID_1=$(jget "$R" "d['device']['id']")
R=$(curl -s --max-time 15 -X POST -b "$(cj orgh)" -c "$(cj orgh)" -H 'Content-Type: application/json' -H "X-Vizito-Device: $DEV_KEY" -d '{}' "http://127.0.0.1:3101/api/device")
check "ثبت مجدد همان دستگاه = به‌روزرسانی (همان ردیف)" "$DEVICE_ID_1" "$(jget "$R" "d['device']['id']")"
C=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST -b "$(cj orgh)" -c "$(cj orgh)" -H 'text/plain' -H "X-Vizito-Device: $DEV_KEY" -d '{}' "http://127.0.0.1:3101/api/device")
check "گیت ضد CSRF روی ثبت دستگاه (403)" "403" "$C"
R=$(rq 3101 owner POST /api/device "{}")
contains "ثبت دستگاه برای سازنده بدون مجموعه (403)" "مجموعه‌دار" "$R"
# اسکوپ مجموعه در DB — orgId دستگاه باید برابر مجموعه «مجموعه لایسنس» باشد (نه از کلاینت)
DEV_ORG=$(python3 -c "
import sqlite3
con=sqlite3.connect('file:$DBB?mode=ro',uri=True)
row=con.execute(\"select o.name from Device d join Org o on o.id=d.orgId where d.deviceKey=?\",('$DEV_KEY',)).fetchone()
print(row[0] if row else 'MISSING')
")
check "orgId دستگاه از نشست سرور (مجموعه درست)" "مجموعه لایسنس" "$DEV_ORG"
# پوسته آفلاین — SW و manifest سرو می‌شوند و API را کش نمی‌کنند
SW=$(curl -s --max-time 15 "http://127.0.0.1:3101/sw.js")
contains "Service Worker سرو می‌شود" "vizito-shell" "$SW"
contains "SW هرگز /api را کش نمی‌کند" "/api/" "$SW"
MF=$(curl -s --max-time 15 "http://127.0.0.1:3101/manifest.json")
contains "manifest سرو می‌شود (نام فارسی)" "ویزیتو" "$MF"
check "manifest status" "200" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://127.0.0.1:3101/manifest.json")"

echo "== ۱۴٫۹) همگام‌سازی چنددستگاهی — /api/sync/* (بخش ششم سند) =="
# ── bundle: احراز/محدوده/بدون قفل لایسنس ──
C=$(code 3101 noauth9 GET /api/sync/bundle)
check "باندل بدون نشست (401)" "401" "$C"
C=$(code 3101 owner GET /api/sync/bundle)
check "باندل برای سازنده بدون مجموعه (403)" "403" "$C"
R=$(rq 3101 orgh GET /api/sync/bundle)
check "باندل موفق — آرایه مشتریان/گروه‌ها" "True" "$(jget "$R" "isinstance(d['customers'],list) and isinstance(d['groups'],list)")"
check "باندل: نام مجموعه از نشست" "مجموعه لایسنس" "$(jget "$R" "d['org']['name']")"
check "باندل: فاز لایسنس ACTIVE" "ACTIVE" "$(jget "$R" "d['license']['phase']")"
# مجموعه کنترل (تریال بسته — تجاری ۴۰۲) باندل می‌گیرد: زیرساخت sync بدون قفل لایسنس است (۵.۴)
R=$(rq 3101 orgc GET /api/sync/bundle)
check "باندل برای مجموعه منقضی باز است + فاز TRIAL_OVER" "True" "$(jget "$R" "d['license']['phase']=='TRIAL_OVER' and isinstance(d['customers'],list)")"

# ── orders: ACCEPTED + متادیتای آفلاین ──
R=$(rq 3101 orgh POST /api/customers "{\"name\":\"مشتری سینک\",\"phone\":\"09120009998\",\"type\":\"STORE\"}")
SYNC_CUST=$(jget "$R" "d['id']")
R=$(rq 3101 orgh POST /api/groups "{\"name\":\"گروه سینک\"}")
SYNC_GRP=$(jget "$R" "d['id']")
R=$(rq 3101 orgh POST /api/products "{\"groupId\":\"$SYNC_GRP\",\"name\":\"کالای سینک\",\"priceStore\":100000,\"pricePharmacy\":0,\"priceSalon\":0}")
SYNC_PROD=$(jget "$R" "d['id']")
DEVH="e2e-sync-dev-$(openssl rand -hex 4)"
SYNC_POST() { # SYNC_POST <user> <json> — ارسال با هویت دستگاه ثابت
  curl -s --max-time 15 -X POST -b "$(cj "$1")" -c "$(cj "$1")" -H 'Content-Type: application/json' -H "X-Vizito-Device: $DEVH" -d "$2" "http://127.0.0.1:3101/api/sync/orders"
}
SO1="$(uuid4)"
R=$(SYNC_POST orgh "{\"orders\":[{\"clientRef\":\"$SO1\",\"customerId\":\"$SYNC_CUST\",\"priceType\":\"STORE\",\"title\":\"فاکتور آفلاین سینک\",\"items\":[{\"productId\":\"$SYNC_PROD\",\"productName\":\"کالای سینک\",\"quantity\":2,\"price\":100000,\"discount\":0}]}]}")
check "سفارش آفلاین منطبق ⇒ ACCEPTED" "ACCEPTED" "$(jget "$R" "d['results'][0]['result']")"
SYNC_ORDER=$(jget "$R" "d['results'][0]['orderId']")
R=$(rq 3101 orgh GET /api/orders)
check "ثبت با createdOffline+syncedAt+deviceId" "True" "$(jget "$R" "any(o['id']=='$SYNC_ORDER' and o['createdOffline']==True and o['syncedAt'] and o['deviceId']=='$DEVH' for o in d)")"
check "قیمت منطبق با کاتالوگ ⇒ needsReview=false" "False" "$(jget "$R" "any(o['id']=='$SYNC_ORDER' and o['needsReview'] for o in d)")"
# ── idempotency: ارسال مجدد همان clientRef ⇒ DUPLICATE با همان orderId، بدون درج دوم ──
R=$(SYNC_POST orgh "{\"orders\":[{\"clientRef\":\"$SO1\",\"customerId\":\"$SYNC_CUST\",\"priceType\":\"STORE\",\"items\":[{\"productId\":\"$SYNC_PROD\",\"productName\":\"کالای سینک\",\"quantity\":2,\"price\":100000,\"discount\":0}]}]}")
check "ارسال مجدد ⇒ DUPLICATE" "DUPLICATE" "$(jget "$R" "d['results'][0]['result']")"
check "DUPLICATE همان شناسه قبلی" "$SYNC_ORDER" "$(jget "$R" "d['results'][0]['orderId']")"
R2=$(rq 3101 orgh GET /api/orders)
DUPN=$(jget "$R2" "sum(1 for o in d if o['clientRef']=='$SO1')")
check "فقط یک ردیف درج شده (هیچ‌گاه دوباره درج نمی‌شود)" "1" "$DUPN"
# ── تعارض قیمت ⇒ ACCEPTED + needsReview + اعلان مدیر ──
SO2="$(uuid4)"
R=$(SYNC_POST orgh "{\"orders\":[{\"clientRef\":\"$SO2\",\"customerId\":\"$SYNC_CUST\",\"priceType\":\"STORE\",\"items\":[{\"productId\":\"$SYNC_PROD\",\"productName\":\"کالای سینک\",\"quantity\":1,\"price\":123456,\"discount\":0}]}]}")
check "تعارض قیمت هم پذیرفته می‌شود (حذف/رد خودکار ممنوع)" "ACCEPTED" "$(jget "$R" "d['results'][0]['result']")"
SYNC_ORDER2=$(jget "$R" "d['results'][0]['orderId']")
R=$(rq 3101 orgh GET /api/orders)
check "تعارض ⇒ needsReview=true" "True" "$(jget "$R" "any(o['id']=='$SYNC_ORDER2' and o['needsReview']==True for o in d)")"
R=$(rq 3101 orgh GET /api/notifications)
check "اعلان بررسی به مدیر مجموعه" "True" "$(jget "$R" "any('بررسی سفارش آفلاین' in (n['title'] or '') for n in d['notifications'])")"
R=$(SYNC_POST orgh "{\"orders\":[{\"clientRef\":\"not-a-uuid\",\"customerId\":\"$SYNC_CUST\",\"items\":[{\"productName\":\"x\",\"quantity\":1,\"price\":1}]}]}")
check "clientRef نامعتبر ⇒ REJECTED(clientRef)" "REJECTED" "$(jget "$R" "d['results'][0]['result']")"
R=$(rq 3101 orgc GET /api/sync/bundle)
ORGC_ORG=$(jget "$R" "d['org']['id']")
node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('$DBB');
d.prepare('INSERT INTO Customer (id,orgId,name,phone,type,archived,createdAt,updatedAt) VALUES (?,?,?,?,?,0,datetime(\'now\'),datetime(\'now\'))').run('custsync-ctrl','$ORGC_ORG','مشتری کنترل سینک','09120009997','STORE');
" >/dev/null 2>&1
SO3="$(uuid4)"
R=$(SYNC_POST orgh "{\"orders\":[{\"clientRef\":\"$SO3\",\"customerId\":\"custsync-ctrl\",\"items\":[{\"productName\":\"x\",\"quantity\":1,\"price\":1}]}]}")
check "مشتری مجموعه دیگر ⇒ REJECTED(customer) — جداسازی ۴۰۴" "REJECTED" "$(jget "$R" "d['results'][0]['result']")"
check "دلیل REJECTED مشتری" "customer" "$(jget "$R" "d['results'][0]['reason']")"
# ── سقف دسته ۵۰ ──
BATCH51=$(python3 -c "
import json
print(json.dumps({'orders':[{'clientRef':'00000000-0000-4000-8000-%012d'%i,'customerId':'$SYNC_CUST','items':[{'productName':'x','quantity':1,'price':1}]} for i in range(51)]}))
")
C=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST -b "$(cj orgh)" -c "$(cj orgh)" -H 'Content-Type: application/json' -H "X-Vizito-Device: $DEVH" -d "$BATCH51" "http://127.0.0.1:3101/api/sync/orders")
check "سقف دسته sync: ۵۱ سفارش (400)" "400" "$C"
# ── گیت CSRF ──
C=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST -b "$(cj orgh)" -c "$(cj orgh)" -H 'text/plain' -d '{}' "http://127.0.0.1:3101/api/sync/orders")
check "گیت CSRF روی sync/orders (403)" "403" "$C"
# ── انقضا (۵.۴): مجموعه منقضه سفارش آفلاین را همگام می‌کند ولی مدیریتش ۴۰۲ است ──
C=$(code 3101 orgc POST /api/customers "{\"name\":\"x\",\"phone\":\"09120000001\"}")
check "مدیریت برای مجموعه منقضه مسدود (402)" "402" "$C"
SO4="$(uuid4)"
R=$(curl -s --max-time 15 -X POST -b "$(cj orgc)" -c "$(cj orgc)" -H 'Content-Type: application/json' -d "{\"orders\":[{\"clientRef\":\"$SO4\",\"customerId\":\"custsync-ctrl\",\"priceType\":\"STORE\",\"items\":[{\"productName\":\"کالای منقضه\",\"quantity\":1,\"price\":50000,\"discount\":0}]}]}" "http://127.0.0.1:3101/api/sync/orders")
check "همگام‌سازی سفارش آفلاین برای مجموعه منقضه پذیرفته می‌شود (۵.۴)" "ACCEPTED" "$(jget "$R" "d['results'][0]['result']")"
# ── support sync: ACCEPTED + DUPLICATE ──
# ── support sync: ACCEPTED + DUPLICATE — با کاربر تازه (سطل لیمیت پشتیبانی ۱۴٫۷ مشترک نیست) ──
SYNCC_MOBILE="0937$(shuf -i 1000000-9999999 -n 1)"
XFF_REG 3101 198.51.100.61 "{\"mobile\":\"$SYNCC_MOBILE\",\"name\":\"مدیر سینک\",\"company\":\"مجموعه سینک\",\"password\":\"$PASSWORD\"}" >/dev/null
rq 3101 syncc POST /api/auth/login "{\"mobile\":\"$SYNCC_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null
SP1="$(uuid4)"
R=$(curl -s --max-time 15 -X POST -b "$(cj syncc)" -c "$(cj syncc)" -H 'Content-Type: application/json' -d "{\"messages\":[{\"clientRef\":\"$SP1\",\"threadId\":\"\",\"subjectType\":\"GENERAL\",\"body\":\"پیام آفلاین سینک\"}]}" "http://127.0.0.1:3101/api/sync/support")
check "پیام پشتیبانی آفلاین ⇒ ACCEPTED + threadId" "True" "$(jget "$R" "d['results'][0]['result']=='ACCEPTED' and bool(d['results'][0].get('threadId'))")"
SP_THREAD=$(jget "$R" "d['results'][0]['threadId']")
R=$(curl -s --max-time 15 -X POST -b "$(cj syncc)" -c "$(cj syncc)" -H 'Content-Type: application/json' -d "{\"messages\":[{\"clientRef\":\"$SP1\",\"threadId\":\"$SP_THREAD\",\"body\":\"ارسال مجدد\"}]}" "http://127.0.0.1:3101/api/sync/support")
check "ارسال مجدد پیام ⇒ DUPLICATE" "DUPLICATE" "$(jget "$R" "d['results'][0]['result']")"
SP2="$(uuid4)"
R=$(curl -s --max-time 15 -X POST -b "$(cj syncc)" -c "$(cj syncc)" -H 'Content-Type: application/json' -d "{\"messages\":[{\"clientRef\":\"$SP2\",\"threadId\":\"$SP_THREAD\",\"body\":\"پاسخ دوم مجموعه روی همان رشته\"}]}" "http://127.0.0.1:3101/api/sync/support")
check "پیام روی رشته مجموعه خودش ⇒ ACCEPTED" "ACCEPTED" "$(jget "$R" "d['results'][0]['result']")"
SO5="$(uuid4)"
LONG_BODY=$(python3 -c "print('ت'*4001)")
R=$(curl -s --max-time 15 -X POST -b "$(cj syncc)" -c "$(cj syncc)" -H 'Content-Type: application/json' -d "{\"messages\":[{\"clientRef\":\"$SO5\",\"threadId\":\"$SP_THREAD\",\"body\":\"$LONG_BODY\"}]}" "http://127.0.0.1:3101/api/sync/support")
check "متن بلندتر از سقف ⇒ REJECTED(body)" "REJECTED" "$(jget "$R" "d['results'][0]['result']")"
check "دلیل REJECTED بدنه" "body" "$(jget "$R" "d['results'][0]['reason']")"
C=$(code 3101 noauth9 POST /api/sync/orders "{}")
check "sync/orders بدون نشست (401)" "401" "$C"

# ── فاز A (اصلاح ممیزی): H1 گرنت بخش + تعلیق + H2 افشای clientRef + H3 ارجاع بیگانه ──
# H1 — کاربر غیرمدیر بدون گرنت «سفارشات» از مسیر آفلاین سفارش نمی‌تواند ثبت کند
NOSYNC_MOBILE="0944$(shuf -i 1000000-9999999 -n 1)"
R=$(rq 3101 orgh POST /api/users "{\"mobile\":\"$NOSYNC_MOBILE\",\"name\":\"پرسنل بدون سفارش\",\"password\":\"$PASSWORD\",\"sections\":[\"customers\",\"dashboard\"],\"durationHours\":null}")
contains "فاز A: ساخت پرسنل بدون گرنت سفارش" '"id"' "$R"
rq 3101 noord POST /api/auth/login "{\"mobile\":\"$NOSYNC_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null
C=$(code 3101 noord POST /api/sync/orders "{\"orders\":[]}")
check "H1: sync/orders بدون گرنت سفارش (403)" "403" "$C"
# H1 — تعلیق امنیتی از مسیر sync دور زده نمی‌شود (انقضای عادی طبق ۵.۴ معاف می‌ماند)
rq 3101 owner POST /api/sa/license "{\"action\":\"suspend\",\"orgId\":\"$ORGC_ORG\"}" >/dev/null
SO_SUSP="$(uuid4)"
C=$(code 3101 orgc POST /api/sync/orders "{\"orders\":[{\"clientRef\":\"$SO_SUSP\",\"customerId\":\"custsync-ctrl\",\"priceType\":\"STORE\",\"items\":[{\"productName\":\"x\",\"quantity\":1,\"price\":1}]}]}")
check "H1: sync/orders برای مجموعه تعلیق‌شده (402)" "402" "$C"
R=$(curl -s --max-time 15 -X POST -b "$(cj orgc)" -c "$(cj orgc)" -H 'Content-Type: application/json' -d "{\"orders\":[{\"clientRef\":\"$SO_SUSP\",\"customerId\":\"custsync-ctrl\",\"priceType\":\"STORE\",\"items\":[{\"productName\":\"x\",\"quantity\":1,\"price\":1}]}]}" "http://127.0.0.1:3101/api/sync/orders")
check "H1: فاز قفل = SUSPENDED" "SUSPENDED" "$(jget "$R" "d.get('lockPhase')")"
rq 3101 owner POST /api/sa/license "{\"action\":\"resume\",\"orgId\":\"$ORGC_ORG\"}" >/dev/null
# H2 — clientRef متعلق به مجموعه دیگر: رد عمومی، بدون افشای وجود/شناسه سفارش بیگانه
R=$(curl -s --max-time 15 -X POST -b "$(cj orgc)" -c "$(cj orgc)" -H 'Content-Type: application/json' -d "{\"orders\":[{\"clientRef\":\"$SO1\",\"customerId\":\"custsync-ctrl\",\"priceType\":\"STORE\",\"items\":[{\"productName\":\"x\",\"quantity\":1,\"price\":1}]}]}" "http://127.0.0.1:3101/api/sync/orders")
check "H2: clientRef مجموعه دیگر ⇒ REJECTED" "REJECTED" "$(jget "$R" "d['results'][0]['result']")"
check "H2: دلیل = duplicate_ref" "duplicate_ref" "$(jget "$R" "d['results'][0]['reason']")"
check "H2: هیچ orderId از سفارش بیگانه افشا نشد" "None" "$(jget "$R" "d['results'][0].get('orderId')")"
R2=$(rq 3101 orgh GET /api/orders)
check "H2: سفارش اصلی مجموعه مالک دست‌نخورده" "1" "$(jget "$R2" "sum(1 for o in d if o['clientRef']=='$SO1')")"
# H3a — productId متعلق به مجموعه دیگر: پذیرش با اسنپ‌شات منجمد، هرگز ارجاع FK (حتی برای مدیر مجموعه منقضه)
SO_H3A="$(uuid4)"
R=$(curl -s --max-time 15 -X POST -b "$(cj orgc)" -c "$(cj orgc)" -H 'Content-Type: application/json' -d "{\"orders\":[{\"clientRef\":\"$SO_H3A\",\"customerId\":\"custsync-ctrl\",\"priceType\":\"STORE\",\"items\":[{\"productId\":\"$SYNC_PROD\",\"productName\":\"کالای بیگانه\",\"quantity\":1,\"price\":123456,\"discount\":0}]}]}" "http://127.0.0.1:3101/api/sync/orders")
check "H3: سفارش با productId بیگانه پذیرفته می‌شود (اسنپ‌شات — D2)" "ACCEPTED" "$(jget "$R" "d['results'][0]['result']")"
H3A_CHECK=$(node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('$DBB');
const r=d.prepare('SELECT oi.productId AS pid, o.needsReview AS nr FROM OrderItem oi JOIN \"Order\" o ON o.id=oi.orderId WHERE o.clientRef=?').get('$SO_H3A');
if(!r){console.log('missing')}else{console.log((r.pid===null?'1':'0')+'|'+((r.nr===1||r.nr===true)?'1':'0'))}
" 2>/dev/null)
check "H3: productId=NULL در DB + needsReview=1" "1|1" "$H3A_CHECK"
# H3b — سقف قیمت ردیف ناشناس برای پرسنل غیرمدیر (جلوگیری از تزریق قیمت با productId جعلی)
# توجه: قانون مسیر آنلاین در sync هم برقرار است — کاربر عادی فقط برای مشتریِ «ساختهٔ خودش» سفارش ثبت می‌کند؛
# پس پرسنل ابتدا مشتری خودش را می‌سازد (بخش customers هم به او گرنت شده)
SYNCSTAFF_MOBILE="0945$(shuf -i 1000000-9999999 -n 1)"
R=$(rq 3101 orgh POST /api/users "{\"mobile\":\"$SYNCSTAFF_MOBILE\",\"name\":\"پرسنل سفارش\",\"password\":\"$PASSWORD\",\"sections\":[\"customers\",\"orders\",\"dashboard\"],\"durationHours\":null}")
contains "H3: ساخت پرسنل با گرنت سفارش" '"id"' "$R"
rq 3101 syncstaff POST /api/auth/login "{\"mobile\":\"$SYNCSTAFF_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null
R=$(rq 3101 syncc POST /api/groups "{\"name\":\"گروه بیگانه\"}")
FCAP_GRP=$(jget "$R" "d['id']")
R=$(rq 3101 syncc POST /api/products "{\"groupId\":\"$FCAP_GRP\",\"name\":\"کالای بیگانه سقف\",\"priceStore\":777000,\"pricePharmacy\":0,\"priceSalon\":0}")
FCAP_PROD=$(jget "$R" "d['id']")
R=$(rq 3101 syncstaff POST /api/customers "{\"name\":\"مشتری پرسنل\",\"phone\":\"0912$(shuf -i 1000000-9999999 -n 1)\",\"type\":\"STORE\"}")
STAFF_CUST=$(jget "$R" "d['id']")
contains "H3: پرسنل مشتری خودش را ساخت" '"id"' "$R"
SO_H3B="$(uuid4)"
R=$(curl -s --max-time 15 -X POST -b "$(cj syncstaff)" -c "$(cj syncstaff)" -H 'Content-Type: application/json' -d "{\"orders\":[{\"clientRef\":\"$SO_H3B\",\"customerId\":\"$STAFF_CUST\",\"priceType\":\"STORE\",\"items\":[{\"productId\":\"$FCAP_PROD\",\"productName\":\"جعل قیمت\",\"quantity\":1,\"price\":2000000000,\"discount\":0}]}]}" "http://127.0.0.1:3101/api/sync/orders")
check "H3: ردیف بیگانه از پرسنل پذیرفته شد (اسنپ‌شات)" "ACCEPTED" "$(jget "$R" "d['results'][0]['result']")"
H3B_CHECK=$(node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('$DBB');
const r=d.prepare('SELECT oi.productId AS pid, oi.price AS pr FROM OrderItem oi JOIN \"Order\" o ON o.id=oi.orderId WHERE o.clientRef=?').get('$SO_H3B');
if(!r){console.log('missing')}else{console.log((r.pid===null?'1':'0')+'|'+(Math.round(r.pr)===1000000000?'1':'0'))}
" 2>/dev/null)
check "H3: productId=NULL + سقف قیمت دستی (۱ میلیارد) اعمال شد" "1|1" "$H3B_CHECK"

echo "== ۱۴٫۱۰) بکاپ/بازیابی — Restore دومرحله‌ای (بخش دهم سند طراحی) =="
# ── آماده‌سازی: پرسنلِ داخل مجموعه — نشستش باید پس از بازیابی باطل شود ──
ORGSTAFF_MOBILE="0943$(shuf -i 1000000-9999999 -n 1)"
R=$(rq 3101 orgh POST /api/users "{\"mobile\":\"$ORGSTAFF_MOBILE\",\"name\":\"پرسنل مجموعه\",\"password\":\"$PASSWORD\",\"sections\":[\"customers\",\"dashboard\"],\"durationHours\":null}")
contains "ساخت پرسنل داخل مجموعه توسط مدیر مجموعه" '"id"' "$R"
rq 3101 orgstaff POST /api/auth/login "{\"mobile\":\"$ORGSTAFF_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null
C=$(code 3101 orgstaff GET /api/auth/me)
check "نشست پرسنل مجموعه برقرار است" "200" "$C"

# ── چرخه ORG: بکاپ ← تغییر داده ← پیش‌نمایش ← تأیید دومرحله‌ای ──
R=$(rq 3101 orgh POST /api/backups)
RB_ORG=$(jget "$R" "d['backup']['id']")
contains "بکاپ دستی مجموعه ساخته شد" '"id"' "$R"
BASE_CUST=$(jget "$(rq 3101 orgh GET /api/customers)" "len(d)")
R=$(rq 3101 orgh POST /api/customers "{\"name\":\"مشتری پس از بکاپ\",\"phone\":\"09120007771\",\"type\":\"STORE\"}")
EXTRA_CUST=$(jget "$R" "d['id']")
AFTER_CUST=$(jget "$(rq 3101 orgh GET /api/customers)" "len(d)")
check "مشتری پس از بکاپ اضافه شد (+۱)" "True" "$([ $((AFTER_CUST - BASE_CUST)) -eq 1 ] && echo True || echo False)"
R=$(rq 3101 orgh POST /api/backups/restore/preview "{\"id\":\"$RB_ORG\"}")
check "پیش‌نمایش: اسکوپ ORG" "ORG" "$(jget "$R" "d['scope']")"
check "پیش‌نمایش: نام مجموعه" "مجموعه لایسنس" "$(jget "$R" "d['orgName']")"
check "پیش‌نمایش: شمارش مشتری = زمان بکاپ (نه الان)" "$BASE_CUST" "$(jget "$R" "d['counts']['customers']")"
C=$(code 3101 orgstaff POST /api/backups/restore/preview "{}")
check "پیش‌نمایش توسط پرسنل (403)" "403" "$C"
R=$(rq 3101 syncc POST /api/backups)
RB_SYNCC=$(jget "$R" "d['backup']['id']")
C=$(code 3101 orgh POST /api/backups/restore/preview "{\"id\":\"$RB_SYNCC\"}")
check "بکاپ مجموعه دیگر برای مدیر مجموعه (404 بدون افشا)" "404" "$C"
C=$(code 3101 orgc POST /api/backups/restore/preview "{\"id\":\"x\"}")
check "مجموعه منقضه به بازیابی نمی‌رسد (402 — قفل قبل از هر چیز)" "402" "$C"
R=$(rq 3101 orgh POST /api/backups/restore/confirm "{\"id\":\"$RB_ORG\",\"password\":\"wrong-pass-123\",\"confirmName\":\"مجموعه لایسنس\"}")
contains "رمز غلط ⇒ بازیابی رد شد" "رمز عبور درست نیست" "$R"
STILL=$(jget "$(rq 3101 orgh GET /api/customers)" "len(d)")
check "پس از رمز غلط هیچ تغییری نکرد" "$AFTER_CUST" "$STILL"
R=$(rq 3101 orgh POST /api/backups/restore/confirm "{\"id\":\"$RB_ORG\",\"password\":\"$PASSWORD\",\"confirmName\":\"نام اشتباه\"}")
contains "نام تایپی غلط ⇒ رد شد" "را دقیقاً وارد کنید" "$R"
STILL=$(jget "$(rq 3101 orgh GET /api/customers)" "len(d)")
check "پس از نام غلط هیچ تغییری نکرد" "$AFTER_CUST" "$STILL"
R=$(rq 3101 orgh POST /api/backups/restore/confirm "{\"id\":\"$RB_ORG\",\"password\":\"$PASSWORD\",\"confirmName\":\"مجموعه لایسنس\"}")
check "تأیید درست ⇒ بازیابی کامل (ok)" "True" "$(jget "$R" "d.get('ok')")"
check "نشست‌های باطل‌شده گزارش شد (≥۱)" "True" "$(jget "$R" "(d.get('sessionsRevoked') or 0) >= 1")"
RESTORED_CUST=$(jget "$(rq 3101 orgh GET /api/customers)" "len(d)")
check "مشتری پس از بکاپ غیب شد (بازگشت به زمان بکاپ)" "$BASE_CUST" "$RESTORED_CUST"
C=$(code 3101 orgstaff GET /api/auth/me)
check "نشست پرسنل مجموعه پس از بازیابی باطل شد (401)" "401" "$C"
rq 3101 orgstaff POST /api/auth/login "{\"mobile\":\"$ORGSTAFF_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null
C=$(code 3101 orgstaff GET /api/auth/me)
check "ورود مجدد پرسنل پس از بازیابی (200)" "200" "$C"
C=$(code 3101 orgh GET /api/auth/me)
check "نشست عملیات‌دهنده (مدیر مجموعه) باقی است" "200" "$C"
C=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST -b "$(cj orgh)" -c "$(cj orgh)" -H 'text/plain' -d '{}' "http://127.0.0.1:3101/api/backups/restore/confirm")
check "گیت CSRF روی بازیابی (403)" "403" "$C"

# ── مسیر آپلود فایل: دانلود ← دستکاری/پاک ← پیش‌نمایش ← تأیید ──
curl -s --max-time 15 -b "$(cj orgh)" -c "$(cj orgh)" "http://127.0.0.1:3101/api/backups/$RB_ORG/download" -o "$TMP/backup-org.json"
check "دانلود بکاپ مجموعه (فایل نامخالی)" "True" "$([ -s "$TMP/backup-org.json" ] && echo True || echo False)"
cp "$TMP/backup-org.json" "$TMP/backup-org-bad.json"; printf 'x' >> "$TMP/backup-org-bad.json"
R=$(rq 3101 orgh POST /api/backups/restore/preview "$(python3 -c "import json;print(json.dumps({'file':open('$TMP/backup-org-bad.json').read()}))")")
contains "پاکت دستکاری‌شده رد شد" "معتبر نیست" "$R"
R=$(rq 3101 orgh POST /api/backups/restore/preview "$(python3 -c "import json;print(json.dumps({'file':open('$TMP/backup-org.json').read()}))")")
check "پیش‌نمایش از فایل آپلودی: نام مجموعه" "مجموعه لایسنس" "$(jget "$R" "d['orgName']")"
R=$(rq 3101 orgh POST /api/customers "{\"name\":\"مشتری دوم پس از بکاپ\",\"phone\":\"09120007772\",\"type\":\"STORE\"}")
EXTRA2_CUST=$(jget "$R" "d['id']")
R=$(rq 3101 orgh POST /api/backups/restore/confirm "$(python3 -c "import json;print(json.dumps({'file':open('$TMP/backup-org.json').read(),'password':'$PASSWORD','confirmName':'مجموعه لایسنس'}))")")
check "بازیابی از فایل آپلودی ⇒ ok" "True" "$(jget "$R" "d.get('ok')")"
R2=$(rq 3101 orgh GET /api/customers)
check "بازیابی از فایل: مشتری دوم غیب شد" "True" "$(jget "$R2" "not any(c['id']=='$EXTRA2_CUST' for c in d)")"

# ── FULL — فقط سازنده؛ جایگزینی کامل سرور با تأیید «بازیابی کامل» ──
R=$(rq 3101 owner POST /api/backups)
RB_FULL=$(jget "$R" "d['backup']['id']")
contains "بکاپ کامل سرور توسط سازنده ساخته شد" '"id"' "$R"
ORGN=$(jget "$(rq 3101 owner GET /api/sa/orgs)" "len(d['orgs'])")
R=$(rq 3101 owner POST /api/backups/restore/preview "{\"id\":\"$RB_FULL\"}")
check "پیش‌نمایش FULL: اسکوپ" "FULL" "$(jget "$R" "d['scope']")"
check "پیش‌نمایش FULL: شمارش مجموعه‌ها" "$ORGN" "$(jget "$R" "d['counts']['orgs']")"
contains "هشدار جایگزینی کامل در پیش‌نمایش" "جایگزین می‌شود" "$R"
C=$(code 3101 orgh POST /api/backups/restore/preview "{\"id\":\"$RB_FULL\"}")
check "بکاپ کامل سرور برای مدیر مجموعه (404 بدون افشا)" "404" "$C"
R=$(rq 3101 orgh POST /api/customers "{\"name\":\"مشتری پس از بکاپ کامل\",\"phone\":\"09120007773\",\"type\":\"STORE\"}")
EXTRA3_CUST=$(jget "$R" "d['id']")
R=$(rq 3101 owner POST /api/backups/restore/confirm "{\"id\":\"$RB_FULL\",\"password\":\"$PASSWORD\",\"confirmName\":\"بازیابی ناقص\"}")
contains "عبارت تأیید غلط برای FULL رد شد" "را دقیقاً وارد کنید" "$R"
STILL3=$(jget "$(rq 3101 orgh GET /api/customers)" "any(c['id']=='$EXTRA3_CUST' for c in d)")
check "پس از عبارت غلط هنوز دست‌نخورده" "True" "$STILL3"
R=$(rq 3101 owner POST /api/backups/restore/confirm "{\"id\":\"$RB_FULL\",\"password\":\"$PASSWORD\",\"confirmName\":\"بازیابی کامل\"}")
check "بازیابی کامل سرور ⇒ ok" "True" "$(jget "$R" "d.get('ok')")"
C=$(code 3101 orgh GET /api/auth/me)
check "نشست مدیر مجموعه پس از بازیابی کامل باطل شد (401)" "401" "$C"
rq 3101 orgh POST /api/auth/login "{\"mobile\":\"$ORGT_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null
R=$(rq 3101 orgh GET /api/customers)
check "مشتری پس از بکاپ کامل غیب شد" "True" "$(jget "$R" "not any(c['id']=='$EXTRA3_CUST' for c in d)")"
C=$(code 3101 owner GET /api/auth/me)
check "نشست سازنده پس از بازیابی کامل باقی است" "200" "$C"
ALRF=$(node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('$DBB');
console.log(d.prepare(\"SELECT COUNT(*) c FROM AdminAccessLog WHERE action='RESTORE_FULL'\").get().c);
")
check "حسابرسی RESTORE_FULL ثبت شد" "1" "$ALRF"

echo "== ۱۴٫۱۱) قطعی کامل دوگانه — سفارش + پشتیبانی آفلاین، تخلیه پس از اتصال (سناریوی سند) =="
OFF_DEV="e2e-offline-dev-$(openssl rand -hex 4)"
R=$(rq 3101 orgh POST /api/customers "{\"name\":\"مشتری پیش از قطعی\",\"phone\":\"09120008881\",\"type\":\"STORE\"}")
OFF_CUST=$(jget "$R" "d['id']")
# «قطعی»: هیچ تماسی با سرور — صف سفارش و صف پشتیبانی با هم پر می‌شوند و با هم تخلیه می‌شوند
OUT_O1="$(uuid4)"; OUT_S1="$(uuid4)"
R=$(curl -s --max-time 15 -X POST -b "$(cj orgh)" -c "$(cj orgh)" -H 'Content-Type: application/json' -H "X-Vizito-Device: $OFF_DEV" -d "{\"orders\":[{\"clientRef\":\"$OUT_O1\",\"customerId\":\"$OFF_CUST\",\"priceType\":\"STORE\",\"title\":\"فاکتور دوران قطعی\",\"items\":[{\"productName\":\"کالای قطعی\",\"quantity\":4,\"price\":90000,\"discount\":0}]}]}" "http://127.0.0.1:3101/api/sync/orders")
check "قطعی دوگانه: صف سفارش تخلیه شد (ACCEPTED)" "ACCEPTED" "$(jget "$R" "d['results'][0]['result']")"
OFF_ORDER=$(jget "$R" "d['results'][0]['orderId']")
# پیام‌های پشتیبانی با پرسنل مجموعه (همان org — سطل لیمیت ۱۰/دقیقه تازه، سطل ۱۴٫۷ مدیر مشترک نیست)
# نشست پرسنل در بازیابی‌های ۱۴٫۱۰ باطل شده — ورود مجدد پیش از ارسال
rq 3101 orgstaff POST /api/auth/login "{\"mobile\":\"$ORGSTAFF_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null
R=$(curl -s --max-time 15 -X POST -b "$(cj orgstaff)" -c "$(cj orgstaff)" -H 'Content-Type: application/json' -d "{\"messages\":[{\"clientRef\":\"$OUT_S1\",\"threadId\":\"\",\"subjectType\":\"GENERAL\",\"body\":\"در دوران قطعی ثبت شد\"}]}" "http://127.0.0.1:3101/api/sync/support")
check "قطعی دوگانه: صف پشتیبانی تخلیه شد (ACCEPTED + threadId)" "True" "$(jget "$R" "d['results'][0]['result']=='ACCEPTED' and bool(d['results'][0].get('threadId'))")"
OFF_THREAD=$(jget "$R" "d['results'][0]['threadId']")
# تلاش مجدد هر دو صف — هیچ درج دومی
R=$(curl -s --max-time 15 -X POST -b "$(cj orgh)" -c "$(cj orgh)" -H 'Content-Type: application/json' -H "X-Vizito-Device: $OFF_DEV" -d "{\"orders\":[{\"clientRef\":\"$OUT_O1\",\"customerId\":\"$OFF_CUST\",\"priceType\":\"STORE\",\"items\":[{\"productName\":\"کالای قطعی\",\"quantity\":4,\"price\":90000,\"discount\":0}]}]}" "http://127.0.0.1:3101/api/sync/orders")
check "تلاش مجدد سفارش ⇒ DUPLICATE با همان شناسه" "DUPLICATE" "$(jget "$R" "d['results'][0]['result']")"
check "DUPLICATE سفارش همان شناسه قبلی" "$OFF_ORDER" "$(jget "$R" "d['results'][0]['orderId']")"
R=$(curl -s --max-time 15 -X POST -b "$(cj orgstaff)" -c "$(cj orgstaff)" -H 'Content-Type: application/json' -d "{\"messages\":[{\"clientRef\":\"$OUT_S1\",\"threadId\":\"$OFF_THREAD\",\"body\":\"تلاش مجدد\"}]}" "http://127.0.0.1:3101/api/sync/support")
contains "تلاش مجدد پیام ⇒ DUPLICATE" "DUPLICATE" "$R"
DUAL=$(node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('$DBB');
const o=d.prepare('SELECT COUNT(*) c FROM \"Order\" WHERE clientRef=?').get('$OUT_O1').c;
const s=d.prepare('SELECT COUNT(*) c FROM SupportMessage WHERE clientRef=?').get('$OUT_S1').c;
const t=d.prepare('SELECT unreadForVendor u FROM SupportThread WHERE id=?').get('$OFF_THREAD');
console.log(o + '/' + s + '/' + (t ? (t.u ? 1 : 0) : -1));
")
check "قطعی دوگانه: دقیقاً یک ردیف سفارش/یک پیام/نخوانده فروشنده" "1/1/1" "$DUAL"
R=$(rq 3101 orgh GET /api/orders)
check "متادیتای آفلاین سفارش قطعی (createdOffline+deviceId+syncedAt)" "True" "$(jget "$R" "any(o['id']=='$OFF_ORDER' and o['createdOffline']==True and o['deviceId']=='$OFF_DEV' and o['syncedAt'] for o in d)")"

echo "== ۱۴٫۱۲) سفارش‌گیری هم‌زمان چنددستگاهی — تست بار شبیه‌سازی‌شده (بخش یازدهم سند) =="
# ۳ دستگاه × ۶ سفارش به‌صورت موازی — همه باید ACCEPTED شوند بدون تداخل
CONC_DEV1="e2e-conc-dev-1-$(openssl rand -hex 3)"
CONC_DEV2="e2e-conc-dev-2-$(openssl rand -hex 3)"
CONC_DEV3="e2e-conc-dev-3-$(openssl rand -hex 3)"
mk_batch() { # هر دستگاه بدنه خودش با clientRefهای یکتا دارد — deviceهای متفاوت، سفارش‌های متفاوت
  python3 -c "
import json,uuid
print(json.dumps({'orders':[{'clientRef':str(uuid.uuid4()),'customerId':'$OFF_CUST','priceType':'STORE','items':[{'productName':'کالای هم‌زمان','quantity':1,'price':60000,'discount':0}]} for _ in range(6)]}))
"
}
B1=$(mk_batch); B2=$(mk_batch); B3=$(mk_batch)
T0=$(date +%s%3N)
curl -s --max-time 30 -X POST -b "$(cj orgh)" -c "$(cj orgh)" -H 'Content-Type: application/json' -H "X-Vizito-Device: $CONC_DEV1" -d "$B1" "http://127.0.0.1:3101/api/sync/orders" > "$TMP/conc1.json" &
P1=$!
curl -s --max-time 30 -X POST -b "$(cj orgh)" -c "$(cj orgh)" -H 'Content-Type: application/json' -H "X-Vizito-Device: $CONC_DEV2" -d "$B2" "http://127.0.0.1:3101/api/sync/orders" > "$TMP/conc2.json" &
P2=$!
curl -s --max-time 30 -X POST -b "$(cj orgh)" -c "$(cj orgh)" -H 'Content-Type: application/json' -H "X-Vizito-Device: $CONC_DEV3" -d "$B3" "http://127.0.0.1:3101/api/sync/orders" > "$TMP/conc3.json" &
P3=$!
wait $P1 $P2 $P3
T1=$(date +%s%3N)
CONC_ACC=$(python3 -c "
import json
n=0
for i in (1,2,3):
    try:
        d=json.load(open('$TMP/conc%d.json'%i))
        n+=sum(1 for r in d.get('results',[]) if r['result']=='ACCEPTED')
    except Exception:
        pass
print(n)
")
check "۱۸ سفارش هم‌زمان از ۳ دستگاه همه ACCEPTED" "18" "$CONC_ACC"
check "زمان کل دسته موازی زیر ۶۰ ثانیه" "True" "$([ $((T1 - T0)) -lt 60000 ] && echo True || echo False)"
CONC_DB=$(node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('$DBB');
console.log(d.prepare('SELECT COUNT(*) c FROM \"Order\" WHERE deviceId IN (?,?,?)').get('$CONC_DEV1','$CONC_DEV2','$CONC_DEV3').c);
")
check "هر ۱۸ سفارش موازی با دستگاه درست در DB" "18" "$CONC_DB"
# برخورد clientRef از دو دستگاه هم‌زمان ⇒ دقیقاً یک ACCEPTED + یک DUPLICATE
COLL_REF="$(uuid4)"
COLL_BODY="{\"orders\":[{\"clientRef\":\"$COLL_REF\",\"customerId\":\"$OFF_CUST\",\"priceType\":\"STORE\",\"items\":[{\"productName\":\"برخورد هم‌زمان\",\"quantity\":1,\"price\":10000,\"discount\":0}]}]}"
curl -s --max-time 30 -X POST -b "$(cj orgh)" -c "$(cj orgh)" -H 'Content-Type: application/json' -H "X-Vizito-Device: $CONC_DEV1" -d "$COLL_BODY" "http://127.0.0.1:3101/api/sync/orders" > "$TMP/coll1.json" &
C1=$!
curl -s --max-time 30 -X POST -b "$(cj orgh)" -c "$(cj orgh)" -H 'Content-Type: application/json' -H "X-Vizito-Device: $CONC_DEV2" -d "$COLL_BODY" "http://127.0.0.1:3101/api/sync/orders" > "$TMP/coll2.json" &
C2=$!
wait $C1 $C2
COLL_RES=$(python3 -c "
import json
res=[]
for i in (1,2):
    d=json.load(open('$TMP/coll%d.json'%i))
    res+=[r['result'] for r in d.get('results',[])]
res.sort()
print(json.dumps(res))
")
check "برخورد هم‌زمان: یک ACCEPTED + یک DUPLICATE" '["ACCEPTED", "DUPLICATE"]' "$COLL_RES"
COLL_N=$(node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('$DBB');
console.log(d.prepare('SELECT COUNT(*) c FROM \"Order\" WHERE clientRef=?').get('$COLL_REF').c);
")
check "برخورد: دقیقاً یک ردیف درج شد" "1" "$COLL_N"

echo "== ۱۵) تست‌های امنیتی قبلی (security-e2e.sh روی سرور B) =="
if BASE_URL="http://127.0.0.1:3101" MOBILE="$OWNER_MOBILE" PASSWORD="$PASSWORD" bash scripts/security-e2e.sh > "$TMP/sec.log" 2>&1; then
  SECN=$(grep -c '✅' "$TMP/sec.log" 2>/dev/null); SECN=${SECN:-?}
  ok "security-e2e.sh کامل پاس شد ($SECN چک)"
else
  bad "security-e2e.sh شکست خورد"; tail -25 "$TMP/sec.log"
fi
echo "== ۱۶) بهداشت لاگ — هیچ وضعیت/مقدار کلیدی لاگ نمی‌شود =="
if grep -q "owner-key diag" "$TMP/a.log" "$TMP/b.log" 2>/dev/null; then
  bad "لاگ عیب‌یابی موقت owner-key هنوز در خروجی سرور هست"
else
  ok "هیچ لاگ عیب‌یابی کلید سازنده در لاگ سرورها نیست"
fi
if grep -qF -- "$SETUP_TOKEN" "$TMP/a.log" "$TMP/b.log" 2>/dev/null || grep -qF -- "$OWNER_SETUP_KEY" "$TMP/a.log" "$TMP/b.log" 2>/dev/null; then
  bad "مقدار SETUP_TOKEN/OWNER_SETUP_KEY در لاگ سرور دیده شد (نشتی!)"
else
  ok "هیچ مقدار SETUP_TOKEN/OWNER_SETUP_KEY در لاگ سرورها ثبت نشده"
fi

kill $B_PID 2>/dev/null

echo
echo "=========================================="
echo "نتیجه نهایی: ✔ $PASS   ✘ $FAIL"
echo "=========================================="
kill_port 3100; kill_port 3101; kill_port 3102
sleep 1
rm -rf "$TMP"
[ $FAIL -eq 0 ] && echo "ALL-PASS" || echo "SOME-FAILED"
exit $FAIL
