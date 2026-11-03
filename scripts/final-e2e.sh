#!/usr/bin/env bash
# =============================================================================
# VIZITO — تست جامع نهایی v1.1.0 (دو سرور مستقل با دیتابیس موقت)
#   سرور A (بدون مالک): ترِیال، قفل‌ها، معافیت پرسنل، مهلت ۳۰ روزه، حذف کنترل‌شده، لایسنس دائمی
#   سرور B (با مالک):   امکانات مالک (دفتر فروش، شارژ، توقف حذف، پیام‌ها، چرخه حیات)
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

echo "== ۱) نصب تازه + اولین مدیر + ترِیال ۲۴ ساعته =="
check "نصب تازه شناسایی شد" "True" "$(jget "$(curl -s http://127.0.0.1:3100/api/license/status)" "d['freshInstall']")"
R=$(rq 3100 none POST /api/auth/register "{\"mobile\":\"$ADMIN_MOBILE\",\"name\":\"مدیر خریدار\",\"password\":\"$PASSWORD\",\"setupToken\":\"$SETUP_TOKEN\"}")
check "ثبت‌نام اولین مدیر → ADMIN" "ADMIN" "$(jget "$R" "d['user']['role']")"
rq 3100 admin POST /api/auth/login "{\"mobile\":\"$ADMIN_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null
R=$(curl -s http://127.0.0.1:3100/api/license/status)
check "ترِیال ۲۴ ساعته فعال شد" "True" "$(jget "$R" "d['trial']")"
check "روزهای باقی‌مانده ترِیال ≥ 0" "True" "$(jget "$R" "str((d['daysLeft'] or 0) >= 0)")"

echo "== ۲) کاربر عمومی + ترِیال شخصی ۲۴ ساعته =="
rq 3100 admin POST /api/settings/invite '{}' >/dev/null
INVITE=$(jget "$(rq 3100 admin GET /api/settings)" "d['inviteCode']")
R=$(rq 3100 none POST /api/auth/register "{\"mobile\":\"$PUBLIC_MOBILE\",\"name\":\"کاربر عمومی\",\"password\":\"$PASSWORD\",\"inviteCode\":\"$INVITE\"}")
check "ثبت‌نام کاربر عمومی با کد دعوت" "USER" "$(jget "$R" "d['user']['role']")"
rq 3100 public POST /api/auth/login "{\"mobile\":\"$PUBLIC_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null
R=$(rq 3100 public GET /api/auth/me)
check "kind=PUBLIC" "PUBLIC" "$(jget "$R" "d['user']['kind']")"
check "ترِیال شخصی (trialUntil)" "True" "$(jget "$R" "d['trialUntil'] is not None")"
check "بخش users در ترِیال باز نیست" "False" "$(jget "$R" "'users' in d['sections']")"
C=$(code 3100 public POST /api/customers '{"name":"مشتری آزمایشی","phone":"09160000001","type":"STORE"}')
check "کاربر عمومی در ترِیال مشتری می‌سازد" "201" "$C"

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

echo "== ۵) پایان ترِیال‌ها (ساعت سرور) — قفل‌ها و معافیت پرسنل =="
node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('$DBA');
const past=new Date(Date.now()-3600_000).toISOString();
d.prepare(\"UPDATE Setting SET value=? WHERE key='trial_until'\").run(past);
d.prepare('UPDATE User SET trialUntil=? WHERE mobile=?').run(past,'$PUBLIC_MOBILE');
" >/dev/null
C=$(code 3100 admin GET /api/customers)
check "مدیر بعد از پایان ترِیال قفل شد (402)" "402" "$C"
R=$(rq 3100 admin GET /api/customers)
contains "کد LICENSE_LOCKED" "LICENSE_LOCKED" "$R"
C=$(code 3100 staff GET /api/customers)
check "پرسنل از قفل پایان ترِیال معاف است (200)" "200" "$C"
C=$(code 3100 public GET /api/customers)
check "کاربر عمومی بعد از ترِیال قفل است (402)" "402" "$C"

echo "== ۶) پایان مهلت ۳۰ روزه + حذف کنترل‌شده خودکار =="
INSTALL_ID=$(jget "$(curl -s http://127.0.0.1:3100/api/license/status)" "d['installId']")
K40=$(sign_key "خریدار آزمایشی" "$ADMIN_MOBILE" "$(($(date +%s%3N) - 40*86400000))" "$INSTALL_ID")
R=$(rq 3100 none POST /api/license/activate "{\"key\":\"$K40\"}")
check "فعال‌سازی کلید ۴۰ روز منقضی" "True" "$(jget "$R" "d.get('ok')")"
# تریگر تنبل: صفحات قفل status را صدا می‌زنند — اینجا هم همین کار و بعد بررسی DB
for _ in $(seq 1 30); do curl -s http://127.0.0.1:3100/api/license/status >/dev/null; sleep 1; done
node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('$DBA');
const q=(t)=>d.prepare('SELECT COUNT(*) c FROM \"'+t+'\"').get().c;
const adminLeft=d.prepare(\"SELECT COUNT(*) c FROM \\\"User\\\" WHERE role='ADMIN' AND mobile != ?\").get('$OWNER_MOBILE').c;
const staffLeft=d.prepare(\"SELECT COUNT(*) c FROM \\\"User\\\" WHERE mobile=?\").get('$STAFF_MOBILE').c;
const publicLeft=d.prepare(\"SELECT COUNT(*) c FROM \\\"User\\\" WHERE kind='PUBLIC'\").get().c;
const log=d.prepare(\"SELECT value FROM Setting WHERE key='data_deleted_at'\").get();
console.log(JSON.stringify({customers:q('Customer'),orders:q('Order'),payments:q('Payment'),adminLeft,staffLeft,publicLeft,logExists:!!log}));
" > "$TMP/sweepA.json"
SW="$(cat "$TMP/sweepA.json")"
check "حذف کنترل‌شده خودکار اجرا شد (لاگ)" "True" "$(jget "$SW" "d['logExists']")"
check "مشتریان حذف شدند" "0" "$(jget "$SW" "d['customers']")"
check "سفارش‌ها حذف شدند" "0" "$(jget "$SW" "d['orders']")"
check "پرداخت‌ها حذف شدند" "0" "$(jget "$SW" "d['payments']")"
check "مدیر غیرِمالک حذف شد" "0" "$(jget "$SW" "d['adminLeft']")"
check "پرسنل حفظ شد" "1" "$(jget "$SW" "d['staffLeft']")"
ls "$TMP/a-data/backups/" >/dev/null 2>&1 && [ -n "$(ls "$TMP/a-data/backups/" 2>/dev/null)" ] && ok "پشتیبان پیش از حذف روی دیسک است" || bad "پشتیبان روی دیسک نیست"

echo "== ۷) مهلت تمدید (کلید ۱ روز منقضی — جدیدتر از ۴۰ روز) =="
K1=$(sign_key "خریدار آزمایشی" "$ADMIN_MOBILE" "$(($(date +%s%3N) - 1*86400000))" "$INSTALL_ID")
R=$(rq 3100 none POST /api/license/activate "{\"key\":\"$K1\"}")
check "فعال‌سازی کلید ۱ روز منقضی" "True" "$(jget "$R" "d.get('ok')")"
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

echo "== ۸) لایسنس مدت‌دار معتبر + تمدید زودهنگام + بازگشت به کار =="
K30=$(sign_key "خریدار آزمایشی" "$ADMIN_MOBILE" "$(($(date +%s%3N) + 30*86400000))" "$INSTALL_ID")
R=$(rq 3100 none POST /api/license/activate "{\"key\":\"$K30\"}")
check "فعال‌سازی لایسنس ۳۰ روزه" "True" "$(jget "$R" "d.get('ok')")"
R=$(curl -s http://127.0.0.1:3100/api/license/status)
check "daysLeft بین ۲۷ تا ۳۱" "True" "$(jget "$R" "27 <= (d['daysLeft'] or 0) <= 31")"
C=$(code 3100 staff GET /api/customers)
check "پرسنل بعد از فعال‌سازی لایسنس دوباره کار می‌کند (200)" "200" "$C"

echo "== ۹) لایسنس دائمی =="
KP=$(sign_key "خریدار دائمی" "$ADMIN_MOBILE" "0" "$INSTALL_ID")
R=$(rq 3100 none POST /api/license/activate "{\"key\":\"$KP\"}")
check "فعال‌سازی دائمی" "True" "$(jget "$R" "d.get('ok')")"
R=$(curl -s http://127.0.0.1:3100/api/license/status)
check "دائمی: permanent" "True" "$(jget "$R" "d.get('permanent')")"
check "دائمی: بدون انقضا" "None" "$(jget "$R" "d['expiresAt']")"
KD=$(sign_key "کلید مدت‌دار" "$ADMIN_MOBILE" "$(($(date +%s%3N) + 90*86400000))" "$INSTALL_ID")
C=$(code 3100 none POST /api/license/activate "{\"key\":\"$KD\"}")
check "کلید مدت‌دار بعد از دائمی رد می‌شود (400)" "400" "$C"

echo "== ۱۰) امنیت عمومی (سرور A) =="
C=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST -H 'Content-Type: text/plain' -d '{}' "http://127.0.0.1:3100/api/auth/login")
check "ورود با text/plain بلاک (403)" "403" "$C"
C=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST -d '{}' "http://127.0.0.1:3100/api/auth/login")
check "ورود بدون Content-Type بلاک (403)" "403" "$C"
# پس از sweep همه نشست‌ها ابطال شده‌اند — با نشست تازه: کاربر عادی نباید به مدیریت کاربران برسد
rq 3100 public POST /api/auth/login "{\"mobile\":\"$PUBLIC_MOBILE\",\"password\":\"$PASSWORD\"}" >/dev/null
C=$(code 3100 public GET /api/users)
check "کاربر عادی (نشست تازه) به مدیریت کاربران دسترسی ندارد (403)" "403" "$C"
kill $A_PID 2>/dev/null

# ===========================================================================
echo "############ سرور B — با مالک (امکانات مالک) ############"
DBB="$TMP/b.db"
B_PID=$(start_server b 3101 "$DBB" OWNER_MOBILES="$OWNER_MOBILE") || exit 1
wait_up 3101 && ok "سرور B آماده شد" || { bad "سرور B بالا نیامد"; tail -15 "$TMP/b.log"; exit 1; }

echo "== ۱۱) مالک + پرسنل =="
R=$(rq 3101 none POST /api/auth/register "{\"mobile\":\"$OWNER_MOBILE\",\"name\":\"مالک برنامه\",\"password\":\"$PASSWORD\",\"setupKey\":\"$OWNER_SETUP_KEY\"}")
check "ثبت‌نام مالک → ADMIN" "ADMIN" "$(jget "$R" "d['user']['role']")"
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

echo "== ۱۵) تست‌های امنیتی قبلی (security-e2e.sh روی سرور B) =="
if BASE_URL="http://127.0.0.1:3101" MOBILE="$OWNER_MOBILE" PASSWORD="$PASSWORD" bash scripts/security-e2e.sh > "$TMP/sec.log" 2>&1; then
  ok "security-e2e.sh کامل پاس شد ($(grep -c '✔' "$TMP/sec.log" 2>/dev/null || echo '?') چک)"
else
  bad "security-e2e.sh شکست خورد"; tail -25 "$TMP/sec.log"
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
