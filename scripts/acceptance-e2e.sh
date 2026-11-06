#!/usr/bin/env bash
# =============================================================================
# VIZITO — ماتریس پذیرش تجاری ۲۷گانه (مرحله ۱۴ دستور تجاری)
# -----------------------------------------------------------------------------
# ۲۷ آیتم پذیرش، هر آیتم با چک‌های «واقعی» روی سرور واقعی (Standalone) و دیتابیس
# موقت اجرا می‌شود — هیچ چک ساختگی/ثابت‌شده‌ای وجود ندارد؛ هر آیتم فقط وقتی PASS
# می‌شود که همه چک‌هایش واقعاً سبز شوند. سرور دوم (بدون سازنده) برای سناریوی
# «نصب تازه» و مهاجرت تمیز استفاده می‌شود.
#
# نکته فنی بدنه درخواست‌ها: JSON از متغیر سراسری JSON خوانده می‌شود (بدنه‌ها
# هرگز داخل $() تو در تو نقل‌قول نمی‌شوند — ضد خطای نحو/رانش نقل‌قول).
#
# اجرا: بعد از «bun run build» →  bash scripts/acceptance-e2e.sh
# هیچ داده‌ای از دیتابیس اصلی تغییر نمی‌کند؛ همه مقادیر حساس هنگام اجرا تصادفی‌اند
# =============================================================================
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
TMP="$(mktemp -d /tmp/vizito-acceptance.XXXXXX)"
kill_port() {
  local PID
  PID=$(ss -tlnp 2>/dev/null | grep ":$1 " | grep -oP 'pid=\K[0-9]+' | head -1)
  [ -n "$PID" ] && kill -9 "$PID" 2>/dev/null
  return 0
}
kill_port 3100; kill_port 3101; sleep 1

PASS=0; FAIL=0
JSON=""  # بدنه درخواست بعدی (الگوی امن — بدون نقل‌قول تو در تو)
ok()  { PASS=$((PASS+1)); echo "    ✔ $1"; }
bad() { FAIL=$((FAIL+1)); echo "    ✘ $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — expected=[$2] actual=[$3]"; fi; }
contains() { case "$3" in *"$2"*) ok "$1" ;; *) bad "$1 — needle=[$2] in=[${3:0:200}]" ;; esac; }
not_contains() { case "$3" in *"$2"*) bad "$1 — باید نباشد: [$2]" ;; *) ok "$1" ;; esac; }
jget() { printf '%s' "$1" | python3 -c "import sys,json;d=json.load(sys.stdin);print($2)" 2>/dev/null || echo "(parse-error)"; }

SETUP_TOKEN="$(openssl rand -hex 12)"
OWNER_SETUP_KEY="$(openssl rand -hex 12)"
OWNER_MOBILE="0912$(shuf -i 1000000-9999999 -n 1)"
ADMIN_A_MOBILE="0913$(shuf -i 1000000-9999999 -n 1)"
ADMIN_B_MOBILE="0915$(shuf -i 1000000-9999999 -n 1)"
STAFF_A_MOBILE="0914$(shuf -i 1000000-9999999 -n 1)"
STAFF2_A_MOBILE="0916$(shuf -i 1000000-9999999 -n 1)"
ADMIN_C_MOBILE="0935$(shuf -i 1000000-9999999 -n 1)"
PASSWORD="Acc-$(openssl rand -hex 6)-!a1"

openssl genpkey -algorithm ED25519 -out "$TMP/lic.pem" 2>/dev/null
openssl pkey -in "$TMP/lic.pem" -pubout -out "$TMP/licpub.pem" 2>/dev/null
LIC_PRIV="$(cat "$TMP/lic.pem")"
LIC_PUB="$(cat "$TMP/licpub.pem")"
BK_KEY="$(openssl rand -base64 48)"

start_server() { # start_server <name> <port> <db> [OWNER_MOBILES مقدار یا «»]
  local name=$1 port=$2 db=$3 ownermob=${4:-}
  DATABASE_URL="file:$db" node scripts/migrate-sqlite.cjs >/dev/null 2>&1 || { echo "migrate-failed $name"; return 1; }
  env DATABASE_URL="file:$db" PORT="$port" HOSTNAME=127.0.0.1 \
      VIZITO_DATA_DIR="$TMP/$name-data" \
      OWNER_MOBILES="$ownermob" \
      SETUP_TOKEN="$SETUP_TOKEN" OWNER_SETUP_KEY="$OWNER_SETUP_KEY" \
      LICENSE_PRIVATE_KEY_PEM="$LIC_PRIV" LICENSE_PUBLIC_KEY_PEM="$LIC_PUB" \
      BACKUP_ENCRYPTION_KEY="$BK_KEY" \
      VIZITO_VENDOR_ORG_NAME="آژیوان پذیرش" \
      node .next/standalone/server.js >"$TMP/$name.log" 2>&1 &
  echo $!
}
wait_up() {
  for _ in $(seq 1 60); do
    curl -s --max-time 2 "http://127.0.0.1:$1/api/auth/status" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}
cj() { echo "$TMP/cookie-$1.txt"; }
rq() { # rq <port> <user> <METHOD> <path> — بدنه از JSON سراسری
  local S=$1 u=$2 m=$3 p=$4
  local args=(-s --max-time 15 -X "$m" -b "$(cj "$u")" -c "$(cj "$u")" -H 'Content-Type: application/json')
  if [ "$m" != "GET" ] && [ -n "$JSON" ]; then args+=(-d "$JSON"); fi
  curl "${args[@]}" "http://127.0.0.1:$S$p"
}
code() { # code <port> <user> <METHOD> <path> — فقط کد وضعیت
  local S=$1 u=$2 m=$3 p=$4
  local args=(-s -o /dev/null -w '%{http_code}' --max-time 15 -X "$m" -b "$(cj "$u")" -c "$(cj "$u")" -H 'Content-Type: application/json')
  if [ "$m" != "GET" ] && [ -n "$JSON" ]; then args+=(-d "$JSON"); fi
  curl "${args[@]}" "http://127.0.0.1:$S$p"
}
rqn() { # rqn <port> <METHOD> <path> — بدون کوکی
  local S=$1 m=$2 p=$3
  local args=(-s --max-time 15 -X "$m" -H 'Content-Type: application/json')
  if [ "$m" != "GET" ] && [ -n "$JSON" ]; then args+=(-d "$JSON"); fi
  curl "${args[@]}" "http://127.0.0.1:$S$p"
}
xreg() { # xreg <port> <xff-ip> — بدنه از JSON سراسری؛ ثبت‌نام با IP متمایز
  curl -s --max-time 15 -H 'Content-Type: application/json' -H "X-Forwarded-For: $2" ${JSON:+-d "$JSON"} "http://127.0.0.1:$1/api/auth/register"
}
db_sql() { # db_sql <db> <sql>
  node -e '
const {DatabaseSync}=require("node:sqlite");
const d=new DatabaseSync(process.argv[1]);
d.exec(process.argv[2]);
d.close();
' "$1" "$2" 2>/dev/null
}
uuid4() { python3 -c 'import uuid;print(uuid.uuid4())'; }
db_count() { # db_count <db> <sql>
  node -e '
const {DatabaseSync}=require("node:sqlite");
const d=new DatabaseSync(process.argv[1]);
console.log(d.prepare(process.argv[2]).get().c);
d.close();
' "$1" "$2" 2>/dev/null || echo "n/a"
}
uuid4() { python3 -c 'import uuid;print(uuid.uuid4())'; }
db_count() { # db_count <db> <sql-select-count>
  node -e '
const {DatabaseSync}=require("node:sqlite");
const d=new DatabaseSync(process.argv[1]);
console.log(d.prepare(process.argv[2]).get().c);
d.close();
' "$1" "$2" 2>/dev/null || echo "n/a"
}

# ═══════════════════════════════════════════════════════════════════════════
echo "########## سرور اصلی — سازنده + دو مجموعه + پرسنل ##########"
DBA="$TMP/a.db"
A_PID=$(start_server a 3100 "$DBA" "$OWNER_MOBILE") || { echo "خطای مهاجرت/بوت سرور A"; exit 1; }
wait_up 3100 || { echo "سرور A بالا نیامد"; tail -15 "$TMP/a.log"; exit 1; }

echo "═══ آیتم ۱ — نصب تازه + گیت SETUP_TOKEN (مرحله راه‌اندازی) ═══"
JSON=""
check "نصب تازه شناسایی شد" "True" "$(jget "$(rqn 3100 GET /api/license/status)" "d['freshInstall']")"
JSON="{\"mobile\":\"0999$(shuf -i 1000000-9999999 -n 1 | cut -c1-7)\",\"name\":\"بدون کلید\",\"company\":\"بدون کلید\",\"password\":\"$PASSWORD\"}"
contains "ثبت‌نام اولین مجموعه بدون SETUP_TOKEN رد شد" "SETUP_TOKEN_REQUIRED" "$(xreg 3100 198.51.100.1)"
JSON="{\"mobile\":\"0998$(shuf -i 1000000-9999999 -n 1 | cut -c1-7)\",\"name\":\"کلید غلط\",\"company\":\"کلید غلط\",\"password\":\"$PASSWORD\",\"setupToken\":\"wrong-token-xyz\"}"
contains "ثبت‌نام با SETUP_TOKEN نادرست رد شد" "SETUP_TOKEN_REQUIRED" "$(xreg 3100 198.51.100.2)"

echo "═══ آیتم ۲ — سازنده: SUPER_ADMIN + «مجموعه من» + PERM (مرحله ۲) ═══"
JSON="{\"mobile\":\"$OWNER_MOBILE\",\"name\":\"سازنده\",\"company\":\"سازنده\",\"password\":\"$PASSWORD\",\"setupKey\":\"$OWNER_SETUP_KEY\"}"
R=$(xreg 3100 198.51.100.3)
check "ثبت‌نام سازنده → SUPER_ADMIN" "SUPER_ADMIN" "$(jget "$R" "d['user']['role']")"
JSON=""
JSON={\"mobile\":\"$OWNER_MOBILE\",\"password\":\"$PASSWORD\"}
rq 3100 vendor POST /api/auth/login >/dev/null
R=$(rq 3100 vendor GET /api/auth/me)
VENDOR_ORG=$(jget "$R" "d['org']['id']")
check "سازنده مجموعه دارد («مجموعه من»)" "True" "$([ -n "$VENDOR_ORG" ] && [ "$VENDOR_ORG" != "None" ] && echo True || echo False)"
check "نام «مجموعه من» درست است" "آژیوان پذیرش" "$(jget "$R" "d['org']['name']")"
R=$(rq 3100 vendor GET /api/license/status)
check "لایسنس «مجموعه من» دائمی (PERM)" "True" "$(jget "$R" "d['permanent']")"
R=$(rq 3100 vendor GET /api/auth/me)
check "بوت‌استرپ idempotent است (دوباره /me → همان مجموعه)" "$VENDOR_ORG" "$(jget "$R" "d['org']['id']")"

echo "═══ آیتم ۳ — کد دعوت فقط منبعش سازنده (M8) ═══"
R=$(rq 3100 vendor GET /api/settings/invite)
INVITE_CODE=$(jget "$R" "d['inviteCode']")
check "سازنده کد دعوت می‌بیند" "True" "$([ -n "$INVITE_CODE" ] && [ "$INVITE_CODE" != "None" ] && echo True || echo False)"
R=$(rq 3100 vendor POST /api/settings/invite)
INVITE_CODE=$(jget "$R" "d['inviteCode']")
check "سازنده کد دعوت می‌چرخاند" "True" "$([ -n "$INVITE_CODE" ] && [ "$INVITE_CODE" != "None" ] && echo True || echo False)"

echo "═══ آیتم ۴ — ثبت‌نام مجموعه‌ها + گیت کد دعوت + ترِیال ۲۴ساعته ═══"
JSON="{\"mobile\":\"$ADMIN_A_MOBILE\",\"name\":\"مدیر الف\",\"company\":\"مجموعه الف\",\"password\":\"$PASSWORD\",\"inviteCode\":\"$INVITE_CODE\"}"
R=$(xreg 3100 198.51.100.4)
check "ثبت‌نام مجموعه الف → ORG_ADMIN" "ORG_ADMIN" "$(jget "$R" "d['user']['role']")"
check "مجموعه الف ساخته شد" "True" "$(jget "$R" "bool(d.get('orgId'))")"
check "ترِیال ۲۴ساعته مجموعه الف در پاسخ هست" "True" "$(jget "$R" "d.get('trialEndsAt') is not None")"
JSON="{\"mobile\":\"0997$(shuf -i 1000000-9999999 -n 1 | cut -c1-7)\",\"name\":\"دعوت غلط\",\"company\":\"دعوت غلط\",\"password\":\"$PASSWORD\",\"inviteCode\":\"no-such-code\"}"
contains "ثبت‌نام با کد دعوت نادرست رد شد" "کد دعوت" "$(xreg 3100 198.51.100.5)"
JSON="{\"mobile\":\"$ADMIN_B_MOBILE\",\"name\":\"مدیر ب\",\"company\":\"مجموعه ب\",\"password\":\"$PASSWORD\",\"inviteCode\":\"$INVITE_CODE\"}"
R=$(xreg 3100 198.51.100.6)
check "ثبت‌نام مجموعه ب → ORG_ADMIN" "ORG_ADMIN" "$(jget "$R" "d['user']['role']")"
JSON=""
JSON={\"mobile\":\"$ADMIN_A_MOBILE\",\"password\":\"$PASSWORD\"}
rq 3100 admina POST /api/auth/login >/dev/null
JSON={\"mobile\":\"$ADMIN_B_MOBILE\",\"password\":\"$PASSWORD\"}
rq 3100 adminb POST /api/auth/login >/dev/null
ORGA=$(jget "$(rq 3100 admina GET /api/auth/me)" "d['org']['id']")
ORGB=$(jget "$(rq 3100 adminb GET /api/auth/me)" "d['org']['id']")
check "دو مجموعه مستقل ساخته شد" "True" "$([ -n "$ORGA" ] && [ -n "$ORGB" ] && [ "$ORGA" != "$ORGB" ] && echo True || echo False)"
check "مدیر مجموعه کد دعوت نمی‌بیند (۴۰۳)" "403" "$(code 3100 admina GET /api/settings/invite)"
check "مدیر مجموعه کد دعوت نمی‌چرخاند (۴۰۳)" "403" "$(code 3100 admina POST /api/settings/invite)"

echo "═══ آیتم ۵ — جداسازی چندمجموعه‌ای مشتری/کالا/سفارش (۴۰۴ بدون افشا) ═══"
JSON="{\"name\":\"مشتری آ\",\"phone\":\"09120000001\"}"
R=$(rq 3100 admina POST /api/customers)
CUST_A=$(jget "$R" "d['id']")
check "مشتری مجموعه الف ساخته شد" "True" "$([ -n "$CUST_A" ] && [ "$CUST_A" != "None" ] && [ "$CUST_A" != "(parse-error)" ] && echo True || echo False)"
JSON="{\"name\":\"گروه آ\"}"
R=$(rq 3100 admina POST /api/groups)
GRP_A=$(jget "$R" "d['id']")
JSON="{\"name\":\"کالای آ\",\"groupId\":\"$GRP_A\",\"priceStore\":1000,\"pricePharmacy\":1000,\"priceSalon\":1000,\"pricePurchase\":500}"
R=$(rq 3100 admina POST /api/products)
PROD_A=$(jget "$R" "d['id']")
check "کالای مجموعه الف ساخته شد" "True" "$([ -n "$PROD_A" ] && [ "$PROD_A" != "None" ] && [ "$PROD_A" != "(parse-error)" ] && echo True || echo False)"
JSON=""
R=$(rq 3100 adminb GET /api/customers)
not_contains "فهرست مشتریان مجموعه ب شامل مشتری الف نیست" "مشتری آ" "$R"
check "مشتری مجموعه الف برای مجموعه ب ۴۰۴ است" "404" "$(code 3100 adminb GET "/api/customers/$CUST_A")"
R=$(rq 3100 adminb GET /api/products)
not_contains "فهرست کالاهای مجموعه ب شامل کالای الف نیست" "کالای آ" "$R"
JSON="{\"customerId\":\"$CUST_A\",\"items\":[{\"productId\":\"$PROD_A\",\"productName\":\"کالای آ\",\"quantity\":1}]}"
check "سفارش مجموعه ب روی مشتری مجموعه الف رد می‌شود" "404" "$(code 3100 adminb POST /api/orders)"
JSON=""
R=$(rq 3100 adminb GET /api/sync/bundle)
not_contains "باندل همگام‌سازی مجموعه ب بدون داده مجموعه الف است" "مشتری آ" "$R"

echo "═══ آیتم ۶ — نقش‌ها/گرنت‌های ماژولی + قیمت خرید فقط نقش مجاز ═══"
JSON="{\"mobile\":\"$STAFF_A_MOBILE\",\"name\":\"پرسنل الف\",\"password\":\"$PASSWORD\",\"role\":\"VISITOR\"}"
R=$(rq 3100 admina POST /api/users)
STAFF_A_ID=$(jget "$R" "d['user']['id'] if d.get('user') else d.get('id')")
check "پرسنل الف ساخته شد" "True" "$([ -n "$STAFF_A_ID" ] && [ "$STAFF_A_ID" != "None" ] && [ "$STAFF_A_ID" != "(parse-error)" ] && echo True || echo False)"
JSON=""
JSON={\"mobile\":\"$STAFF_A_MOBILE\",\"password\":\"$PASSWORD\"}
rq 3100 staffa POST /api/auth/login >/dev/null
JSON="{\"mobile\":\"$STAFF2_A_MOBILE\",\"name\":\"پرسنل۲ الف\",\"password\":\"$PASSWORD\",\"role\":\"VISITOR\"}"
R=$(rq 3100 admina POST /api/users)
STAFF2_A_ID=$(jget "$R" "d['user']['id'] if d.get('user') else d.get('id')")
JSON=""
JSON={\"mobile\":\"$STAFF2_A_MOBILE\",\"password\":\"$PASSWORD\"}
rq 3100 staff2a POST /api/auth/login >/dev/null
JSON="{\"name\":\"تست پرسنل\",\"phone\":\"09120000002\"}"
check "پرسنل بدون گرنت مشتری نمی‌سازد (۴۰۳)" "403" "$(code 3100 staffa POST /api/customers)"
JSON="{\"customerId\":\"$CUST_A\",\"items\":[{\"productId\":\"$PROD_A\",\"productName\":\"کالای آ\",\"quantity\":1}]}"
check "پرسنل بدون گرنت سفارش نمی‌سازد (۴۰۳)" "403" "$(code 3100 staffa POST /api/orders)"
JSON="{\"sections\":[\"customers\",\"orders\"],\"expiresAt\":null}"
check "گرنت به پرسنل داده شد" "201" "$(code 3100 admina POST "/api/users/$STAFF_A_ID/grant")"
JSON="{\"name\":\"مشتری پرسنل\",\"phone\":\"09120000003\"}"
R=$(rq 3100 staffa POST /api/customers)
check "پرسنلِ گرنت‌دار مشتری می‌سازد" "True" "$(jget "$R" "str(d.get('error',''))==''")"
JSON=""
R=$(rq 3100 staffa GET /api/products)
not_contains "قیمت خرید برای پرسنل معمولی مخفی است" "500" "$R"
R=$(rq 3100 admina GET /api/products)
contains "قیمت خرید برای مدیر نمایان است" "500" "$R"

echo "═══ آیتم ۹(الف) — قفل پس از ترِیال: عملیات ۴۰۲، مشاهده آزاد، داده محفوظ ═══"
NOW_MS="$(date +%s)000"
db_sql "$DBA" "UPDATE Org SET trialEndsAt=$NOW_MS WHERE id='$ORGA';"
JSON=""
R=$(rq 3100 admina GET /api/auth/me)
check "قفل پس از ترِیال فعال شد" "True" "$(jget "$R" "d['licenseLocked']")"
check "صفحه وضعیت لایسنس در قفل در دسترس است (مشاهده آزاد)" "200" "$(code 3100 admina GET /api/license/status)"
JSON="{\"name\":\"در قفل\",\"phone\":\"09120000004\"}"
check "ایجاد مشتری در قفل ۴۰۲ است" "402" "$(code 3100 admina POST /api/customers)"
contains "پیام قفل حاوی تضمین حفظ اطلاعات است" "محفوظ" "$(rq 3100 admina POST /api/customers)"

echo "═══ آیتم ۷ — صدور کلید VZT3 از پنل فروش سازنده + حسابرسی ISSUE ═══"
JSON="{\"action\":\"issueKey\",\"orgId\":\"$ORGA\",\"plan\":\"X99\"}"
check "صدور با پلن نامعتبر رد می‌شود (۴۰۰)" "400" "$(code 3100 vendor POST /api/sa/license)"
JSON="{\"action\":\"issueKey\",\"orgId\":\"no-such-org\",\"plan\":\"D30\"}"
check "صدور برای مجموعه ناشناس ۴۰۴ است" "404" "$(code 3100 vendor POST /api/sa/license)"
JSON="{\"action\":\"issueKey\",\"orgId\":\"$ORGA\",\"plan\":\"D30\",\"note\":\"کلید پذیرش\"}"
R=$(rq 3100 vendor POST /api/sa/license)
KEY_A=$(jget "$R" "d['key']")
check "کلید VZT3 صادر شد" "True" "$(case "$KEY_A" in VZT3.*) echo True;; *) echo False;; esac)"
JSON="{\"action\":\"issueKey\",\"orgId\":\"$ORGA\",\"plan\":\"D30\"}"
check "مدیر مجموعه از پنل سازنده صدور نمی‌کند (۴۰۳)" "403" "$(code 3100 adminb POST /api/sa/license)"

echo "═══ آیتم ۸ — امنیت کلید VZT3: امضای غلط/مجموعه اشتباه/فعال‌سازی سالم ═══"
TAMPERED="${KEY_A%?}X"
JSON="{\"key\":\"$TAMPERED\"}"
R=$(rq 3100 admina POST /api/license/activate)
contains "کلید دست‌کاری‌شده رد شد (امضا)" "نامعتبر" "$R"
JSON="{\"key\":\"$KEY_A\"}"
R=$(rq 3100 adminb POST /api/license/activate)
check "کلید حتی از نشست مجموعه دیگر فقط مجموعه مقصد خودش را فعال می‌کند" "مجموعه الف" "$(jget "$R" "d['name']")"
JSON=""
R=$(rq 3100 adminb GET /api/license/status)
check "مجموعه ب بدون لایسنس باقی ماند (ترِیال)" "True" "$(jget "$R" "d['trial']")"
JSON="{\"key\":\"$KEY_A\"}"
R=$(rq 3100 admina POST /api/license/activate)
contains "اعمال مجدد همان کلید رد شد (ضداستفاده مجدد)" "قبلاً" "$R"
JSON=""
check "پس از فعال‌سازی قفل برداشته شد" "False" "$(jget "$(rq 3100 admina GET /api/auth/me)" "d['licenseLocked']")"
DAYS_LEFT=$(jget "$(rq 3100 admina GET /api/license/status)" "d['daysLeft']")
check "روزهای باقیمانده ≈۳۰ است" "True" "$([ "$DAYS_LEFT" -ge 29 ] && [ "$DAYS_LEFT" -le 31 ] 2>/dev/null && echo True || echo False)"

echo "═══ آیتم ۱۰ — تمدید زودهنگام: حفظ دقیق زمان باقیمانده ═══"
JSON="{\"action\":\"extend\",\"orgId\":\"$ORGA\",\"days\":10,\"note\":\"شارژ ۱۰ روزه\"}"
R=$(rq 3100 vendor POST /api/sa/license)
check "تمدید موفق" "True" "$(jget "$R" "d['ok']")"
JSON=""
DAYS_LEFT2=$(jget "$(rq 3100 admina GET /api/license/status)" "d['daysLeft']")
check "زمان باقیمانده حفظ شد (≈۴۰ نه ≈۱۰)" "True" "$([ "$DAYS_LEFT2" -ge 39 ] && [ "$DAYS_LEFT2" -le 41 ] 2>/dev/null && echo True || echo False)"

echo "═══ آیتم ۱۱ — تعلیق امنیتی SUSPENDED: قفل شامل sync + خودفعال‌سازی ممنوع ═══"
JSON="{\"action\":\"suspend\",\"orgId\":\"$ORGA\",\"note\":\"تعلیق آزمون\"}"
R=$(rq 3100 vendor POST /api/sa/license)
check "تعلیق انجام شد" "SUSPENDED" "$(jget "$R" "d['status']")"
JSON="{\"action\":\"issueKey\",\"orgId\":\"$ORGA\",\"plan\":\"D30\",\"note\":\"کلید دوم\"}"
R=$(rq 3100 vendor POST /api/sa/license)
KEY_A2=$(jget "$R" "d['key']")
JSON="{\"name\":\"تعلیق\",\"phone\":\"09120000005\"}"
check "عملیات مدیریتی در تعلیق ۴۰۲ است" "402" "$(code 3100 admina POST /api/customers)"
JSON="{\"orders\":[{\"clientRef\":\"acc-susp-1\",\"customerId\":\"$CUST_A\",\"items\":[{\"productName\":\"کالای آ\",\"quantity\":1,\"price\":1000}]}]}"
check "sync/orders در تعلیق هم ۴۰۲ است (H1)" "402" "$(code 3100 admina POST /api/sync/orders)"
JSON="{\"key\":\"$KEY_A2\"}"
R=$(rq 3100 admina POST /api/license/activate)
contains "خودفعال‌سازی مجموعه تعلیق‌شده با کلید جدید رد شد" "تعلیق" "$R"

echo "═══ آیتم ۱۲ — رفع تعلیق از پنل سازنده + زنجیره رویدادهای لایسنس ═══"
JSON="{\"action\":\"resume\",\"orgId\":\"$ORGA\",\"note\":\"رفع تعلیق آزمون\"}"
R=$(rq 3100 vendor POST /api/sa/license)
check "رفع تعلیق انجام شد" "ACTIVE" "$(jget "$R" "d['status']")"
JSON=""
R=$(rq 3100 vendor GET "/api/sa/license?orgId=$ORGA")
EV=$(jget "$R" "'|'.join(e['type'] for e in d.get('events',[]))")
contains "رویداد ISSUE ثبت شده" "ISSUE" "$EV"
contains "رویداد EXTEND ثبت شده" "EXTEND" "$EV"
contains "رویداد SUSPEND ثبت شده" "SUSPEND" "$EV"
contains "رویداد RESUME ثبت شده" "RESUME" "$EV"

echo "═══ آیتم ۱۳ — انقضای عادی: قفل عملیات، داده هرگز حذف نمی‌شود (D2) ═══"
CUST_COUNT_BEFORE=$(db_count "$DBA" "SELECT COUNT(*) c FROM Customer WHERE orgId='$ORGA'")
PAST_MS=$(( $(date +%s) - 86400 ))000
db_sql "$DBA" "UPDATE License SET expiresAt=$PAST_MS WHERE orgId='$ORGA';"
R=$(rq 3100 admina GET /api/auth/me)
check "قفل انقضا فعال شد" "True" "$(jget "$R" "d['licenseLocked']")"
check "صفحه وضعیت لایسنس در انقضا در دسترس است" "200" "$(code 3100 admina GET /api/license/status)"
CUST_COUNT_AFTER=$(db_count "$DBA" "SELECT COUNT(*) c FROM Customer WHERE orgId='$ORGA'")
check "هیچ داده‌ای حذف نشده (D2 — شمارش مستقیم دیتابیس)" "$CUST_COUNT_BEFORE" "$CUST_COUNT_AFTER"
JSON="{\"name\":\"منقضی\",\"phone\":\"09120000006\"}"
check "ایجاد مشتری در انقضا ۴۰۲ است" "402" "$(code 3100 admina POST /api/customers)"
JSON=""
GRACE=$(jget "$(rq 3100 admina GET /api/license/status)" "d['graceDaysLeft']")
check "مهلت تمدید ۳۰ روزه با شمارش معکوس نمایش داده می‌شود" "True" "$([ "$GRACE" -ge 29 ] && [ "$GRACE" -le 30 ] 2>/dev/null && echo True || echo False)"

echo "═══ آیتم ۱۴ — همگام‌سازی سفارش آفلاین حتی پس از انقضا (بخش ۵.۴) ═══"
CR1="$(uuid4)"
JSON="{\"orders\":[{\"clientRef\":\"$CR1\",\"customerId\":\"$CUST_A\",\"items\":[{\"productId\":\"$PROD_A\",\"productName\":\"کالای آ\",\"quantity\":2,\"price\":1000}]}]}"
R=$(rq 3100 admina POST /api/sync/orders)
ORDER1_ID=$(jget "$R" "d['results'][0].get('orderId')")
check "سفارش آفلاین پس از انقضای عادی پذیرفته شد (۵.۴)" "ACCEPTED" "$(jget "$R" "d['results'][0]['result']")"
check "شناسه سفارش در پاسخ هست" "True" "$([ -n "$ORDER1_ID" ] && [ "$ORDER1_ID" != "None" ] && echo True || echo False)"

echo "═══ آیتم ۱۵ — گیت‌های sync/orders: گرنت (H1) + clientRef بیگانه (H2) + کالای بیگانه (H3) ═══"
JSON=""
JSON="{\"orders\":[{\"clientRef\":\"acc-h1-1\",\"customerId\":\"$CUST_A\",\"items\":[{\"productName\":\"x\",\"quantity\":1,\"price\":10}]}]}"
check "پرسنل بدون گرنت «سفارشات» sync ندارد (H1)" "403" "$(code 3100 staff2a POST /api/sync/orders)"
JSON="{\"name\":\"مشتری ب\",\"phone\":\"09150000001\"}"
R=$(rq 3100 adminb POST /api/customers)
CUST_B=$(jget "$R" "d['id']")
JSON="{\"orders\":[{\"clientRef\":\"$CR1\",\"customerId\":\"$CUST_B\",\"items\":[{\"productName\":\"x\",\"quantity\":1,\"price\":10}]}]}"
R=$(rq 3100 adminb POST /api/sync/orders)
check "clientRef متعلق به مجموعه دیگر → REJECTED" "REJECTED" "$(jget "$R" "d['results'][0]['result']")"
check "دلیل رد duplicate_ref است (H2)" "duplicate_ref" "$(jget "$R" "d['results'][0]['reason']")"
check "هیچ orderId بیگانه‌ای افشا نشد (H2)" "True" "$(jget "$R" "d['results'][0].get('orderId') is None")"
CR_H3="$(uuid4)"
JSON="{\"orders\":[{\"clientRef\":\"$CR_H3\",\"customerId\":\"$CUST_B\",\"items\":[{\"productId\":\"$PROD_A\",\"productName\":\"کالای آ\",\"quantity\":1,\"price\":1000}]}]}"
R=$(rq 3100 adminb POST /api/sync/orders)
ORDER_H3=$(jget "$R" "d['results'][0].get('orderId')")
check "سفارش با کالای بیگانه پذیرفته شد (سیاست اسنپ‌شات)" "ACCEPTED" "$(jget "$R" "d['results'][0]['result']")"
JSON=""
R=$(rq 3100 adminb GET "/api/orders/$ORDER_H3")
check "هرگز FK به کالای مجموعه دیگر برقرار نشد (productId=null)" "True" "$(jget "$R" "d['items'][0].get('productId') is None")"
check "سفارش برای بررسی مدیر علامت خورد (needsReview)" "True" "$(jget "$R" "d['needsReview']")"

echo "═══ آیتم ۱۶ — idempotency چنددستگاهی: DUPLICATE + دستگاه دوم مستقل ═══"
JSON="{\"orders\":[{\"clientRef\":\"$CR1\",\"customerId\":\"$CUST_A\",\"items\":[{\"productId\":\"$PROD_A\",\"productName\":\"کالای آ\",\"quantity\":2,\"price\":1000}]}]}"
R=$(rq 3100 admina POST /api/sync/orders)
check "ارسال مجدد همان clientRef → DUPLICATE" "DUPLICATE" "$(jget "$R" "d['results'][0]['result']")"
check "DUPLICATE همان orderId را برمی‌گرداند" "$ORDER1_ID" "$(jget "$R" "d['results'][0].get('orderId')")"
check "تعداد accepted=0 است (هیچ درج دوباره‌ای)" "0" "$(jget "$R" "d['accepted']")"
CR2="$(uuid4)"
JSON="{\"orders\":[{\"clientRef\":\"$CR2\",\"customerId\":\"$CUST_A\",\"items\":[{\"productName\":\"ردیف دستی\",\"quantity\":1,\"price\":500}]}]}"
R=$(curl -s --max-time 15 -X POST -b "$(cj admina)" -c "$(cj admina)" -H 'Content-Type: application/json' -H 'X-Vizito-Device: dev-accept-2' -d "$JSON" "http://127.0.0.1:3100/api/sync/orders")
check "دستگاه دوم با clientRef جدید مستقل درج می‌کند" "ACCEPTED" "$(jget "$R" "d['results'][0]['result']")"

echo "═══ آیتم ۱۷ — تعویض حساب روی یک دستگاه: صفر نشت داده بین حساب‌ها ═══"
J="$TMP/cookie-swap.txt"
JSON=""
curl -s --max-time 15 -X POST -b "$J" -c "$J" -H 'Content-Type: application/json' -d "{\"mobile\":\"$ADMIN_A_MOBILE\",\"password\":\"$PASSWORD\"}" "http://127.0.0.1:3100/api/auth/login" >/dev/null
check "خروج حساب اول موفق" "200" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST -b "$J" -c "$J" -H 'Content-Type: application/json' "http://127.0.0.1:3100/api/auth/logout")"
curl -s --max-time 15 -X POST -b "$J" -c "$J" -H 'Content-Type: application/json' -d "{\"mobile\":\"$ADMIN_B_MOBILE\",\"password\":\"$PASSWORD\"}" "http://127.0.0.1:3100/api/auth/login" >/dev/null
R=$(curl -s --max-time 15 -b "$J" -c "$J" -H 'Content-Type: application/json' "http://127.0.0.1:3100/api/auth/me")
check "نشست جدید متعلق به مجموعه ب است" "مجموعه ب" "$(jget "$R" "d['org']['name']")"
R=$(curl -s --max-time 15 -b "$J" -c "$J" -H 'Content-Type: application/json' "http://127.0.0.1:3100/api/customers")
not_contains "هیچ مشتری از مجموعه قبلی در نشست جدید نیست" "مشتری آ" "$R"
R=$(curl -s --max-time 15 -b "$J" -c "$J" -H 'Content-Type: application/json' "http://127.0.0.1:3100/api/sync/bundle")
not_contains "باندل دستگاهِ تعویض‌شده بدون داده مجموعه قبلی است" "مشتری آ" "$R"

echo "═══ آیتم ۱۸ — نشست امن: کوکی HttpOnly/SameSite + هش توکن + ابطال با تغییر رمز ═══"
HDRS=$(curl -s -i --max-time 15 -X POST -H 'Content-Type: application/json' -d "{\"mobile\":\"$STAFF2_A_MOBILE\",\"password\":\"$PASSWORD\"}" -c "$TMP/cookie-pw.txt" "http://127.0.0.1:3100/api/auth/login")
contains "کوکی نشست HttpOnly است" "HttpOnly" "$HDRS"
contains "کوکی نشست SameSite دارد" "SameSite" "$HDRS"
RAW_TOKEN=$(printf '%s' "$HDRS" | grep -i 'set-cookie' | sed -E 's/.*vizito_session=([^;]+).*/\1/' | head -1)
FOUND_RAW=$(node -e '
const {DatabaseSync}=require("node:sqlite");
const d=new DatabaseSync(process.argv[1]);
const r=d.prepare("SELECT COUNT(*) c FROM AuthSession WHERE tokenHash=?").get(process.argv[2]);
console.log(r.c);
' "$DBA" "$RAW_TOKEN" 2>/dev/null || echo "n/a")
check "خود توکن در دیتابیس ذخیره نشده (فقط هش)" "0" "$FOUND_RAW"
FOUND_HASH=$(node -e '
const crypto=require("crypto");
const {DatabaseSync}=require("node:sqlite");
const d=new DatabaseSync(process.argv[1]);
const h=crypto.createHash("sha256").update(process.argv[2]).digest("hex");
const r=d.prepare("SELECT COUNT(*) c FROM AuthSession WHERE tokenHash=?").get(h);
console.log(r.c);
' "$DBA" "$RAW_TOKEN" 2>/dev/null || echo "n/a")
check "هش SHA-256 توکن در دیتابیس ثبت شده" "1" "$FOUND_HASH"
curl -s --max-time 15 -X POST -H 'Content-Type: application/json' -d "{\"mobile\":\"$STAFF2_A_MOBILE\",\"password\":\"$PASSWORD\"}" -c "$TMP/cookie-s2b.txt" "http://127.0.0.1:3100/api/auth/login" >/dev/null
check "نشست دوم پرسنل۲ فعال است" "200" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -b "$TMP/cookie-s2b.txt" "http://127.0.0.1:3100/api/auth/me")"
JSON="{\"currentPassword\":\"$PASSWORD\",\"newPassword\":\"${PASSWORD}Xx9\"}"
R=$(rq 3100 staff2a POST /api/auth/change-password)
check "تغییر رمز موفق بود" "True" "$(jget "$R" "d['ok']")"
JSON=""
check "نشست دوم پس از تغییر رمز باطل شد (۴۰۱)" "401" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -b "$TMP/cookie-s2b.txt" "http://127.0.0.1:3100/api/auth/me")"
check "نشستِ تغییردهنده حفظ می‌شود (۲۰۰)" "200" "$(code 3100 staff2a GET /api/auth/me)"
JSON="{\"mobile\":\"$STAFF2_A_MOBILE\",\"password\":\"${PASSWORD}Xx9\"}"
R=$(rq 3100 staff2a POST /api/auth/login)
check "ورود با رمز جدید سالم است" "True" "$(jget "$R" "str(d.get('error',''))==''")"

echo "═══ آیتم ۱۹ — گیت CSRF دو لایه: Content-Type و Origin ═══"
JSON="{\"name\":\"csrf\",\"phone\":\"09120000007\"}"
check "بدنه با Content-Type نادرست رد می‌شود (۴۰۳)" "403" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST -b "$(cj admina)" -c "$(cj admina)" -H 'Content-Type: text/plain' -d "$JSON" "http://127.0.0.1:3100/api/customers")"
check "Origin بیگانه با هاست عمومی رد می‌شود (۴۰۳)" "403" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST -H 'Host: public-host.example' -b "$(cj adminb)" -c "$(cj adminb)" -H 'Content-Type: application/json' -H 'Origin: https://evil.example' -d "$JSON" "http://127.0.0.1:3100/api/customers")"
check "هشت داخلی (ابزار تست/آفلاین) بدون Origin عبور می‌کند" "201" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST -b "$(cj adminb)" -c "$(cj adminb)" -H 'Content-Type: application/json' -d "$JSON" "http://127.0.0.1:3100/api/customers")"

echo "═══ آیتم ۲۰ — محدودسازی نرخ دیتابیسی: ورودهای ناموفق → ۴۲۹ ═══"
RL_CODE="200"
for i in 1 2 3 4 5 6 7 8 9 10; do
  RL_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST -H 'Content-Type: application/json' -H 'X-Forwarded-For: 203.0.113.77' -d "{\"mobile\":\"$STAFF2_A_MOBILE\",\"password\":\"wrong-pass-$i\"}" "http://127.0.0.1:3100/api/auth/login")
  [ "$RL_CODE" = "429" ] && break
done
check "پس از تلاش‌های ناموفق متوالی ۴۲۹ برمی‌گردد" "429" "$RL_CODE"

echo "═══ آیتم ۲۱ — حسابرسی پنل سازنده: AdminAccessLog ثبت شده (fail-closed) ═══"
JSON=""
R=$(rq 3100 vendor GET "/api/sa/access-logs?page=1&pageSize=100")
LOGS=$(jget "$R" "'|'.join(l['action'] for l in d.get('logs',[]))")
contains "حسابرسی ISSUE_LICENSE_KEY ثبت شده" "ISSUE_LICENSE_KEY" "$LOGS"
contains "حسابرسی SUSPEND_ORG ثبت شده" "SUSPEND_ORG" "$LOGS"
contains "حسابرسی RESUME ثبت شده" "RESUME" "$LOGS"
check "مدیر مجموعه به لاگ‌های سراسری دسترسی ندارد (۴۰۳)" "403" "$(code 3100 adminb GET /api/sa/access-logs)"

echo "═══ آیتم ۲۲ — بکاپ ORG-scoped: ضد انتقال بین مجموعه‌ها + FULL فقط سازنده ═══"
JSON=""
R=$(rq 3100 adminb POST /api/backups)
BK_B=$(jget "$R" "d['backup']['id']")
check "بکاپ مجموعه ب ساخته شد" "True" "$([ -n "$BK_B" ] && [ "$BK_B" != "None" ] && [ "$BK_B" != "(parse-error)" ] && echo True || echo False)"
R=$(rq 3100 admina GET /api/backups)
not_contains "فهرست بکاپ مجموعه الف شامل بکاپ مجموعه ب نیست" "$BK_B" "$R"
CODE_X=$(code 3100 admina GET "/api/backups/$BK_B/download")
check "دانلود بکاپ مجموعه ب توسط مجموعه الف رد می‌شود (۴۰۴/۴۰۲)" "True" "$(case "$CODE_X" in 404|402) echo True;; *) echo False;; esac)"
JSON="{\"scope\":\"FULL\"}"
CODE_F=$(code 3100 admina POST /api/backups)
check "بکاپ FULL توسط مدیر مجموعه رد می‌شود (۴۰۳/۴۰۲)" "True" "$(case "$CODE_F" in 403|402) echo True;; *) echo False;; esac)"
JSON="{\"scope\":\"FULL\"}"
R=$(rq 3100 vendor POST /api/backups)
BK_FULL=$(jget "$R" "d['backup']['id']")
check "بکاپ FULL توسط سازنده ساخته شد" "True" "$([ -n "$BK_FULL" ] && [ "$BK_FULL" != "None" ] && echo True || echo False)"
JSON="{\"id\":\"$BK_FULL\"}"
R=$(rq 3100 vendor POST /api/backups/restore/preview)
check "پیش‌نمایش بکاپ FULL سازنده → scope=FULL" "FULL" "$(jget "$R" "d['scope']")"

echo "═══ آیتم ۲۳ — پشتیبان رمزنگاری‌شده (AES-256-GCM) + بازگردانی سالم/ضد بین‌مجموعه‌ای ═══"
JSON=""
curl -s --max-time 15 -b "$(cj adminb)" -c "$(cj adminb)" "http://127.0.0.1:3100/api/backups/$BK_B/download" -o "$TMP/bk-b.json"
contains "فایل پشتیبان با پاکت VIZITO-ENC-2 رمز شده" "VIZITO-ENC-2" "$(cat "$TMP/bk-b.json")"
not_contains "داده مشتری داخل فایل پشتیبان plaintext نیست" "مشتری ب" "$(cat "$TMP/bk-b.json")"
JSON="{\"id\":\"$BK_B\"}"
R=$(rq 3100 admina POST /api/backups/restore/preview)
check "پیش‌نمایش بکاپ مجموعه ب توسط مجموعه الف رد می‌شود (ضد انتقال)" "True" "$(jget "$R" "bool(d.get('error'))")"
R=$(rq 3100 adminb POST /api/backups/restore/preview)
check "پیش‌نمایش بکاپ توسط صاحبش مجاز است (scope=ORG)" "ORG" "$(jget "$R" "d['scope']")"
JSON="{\"id\":\"$BK_B\",\"password\":\"$PASSWORD\",\"confirmName\":\"مجموعه ب\"}"
R=$(rq 3100 adminb POST /api/backups/restore/confirm)
check "بازگردانی دو مرحله‌ای سالم انجام شد" "True" "$(jget "$R" "d['ok']")"
JSON=""
R=$(rq 3100 adminb GET /api/customers)
contains "داده پس از بازگردانی سر جایش است" "مشتری ب" "$R"

echo "═══ آیتم ۲۴ — پشتیبانی داخلی حتی در حالت قفل تجاری + جریان سازنده ═══"
JSON="{\"body\":\"نیاز به کمک در حالت قفل لایسنس داریم\",\"subjectType\":\"GENERAL\"}"
R=$(rq 3100 admina POST /api/support/threads)
TID=$(jget "$R" "d['thread']['id'] if d.get('thread') else d.get('id')")
check "تیکت در حالت قفل تجاری ایجاد شد" "True" "$([ -n "$TID" ] && [ "$TID" != "None" ] && [ "$TID" != "(parse-error)" ] && echo True || echo False)"
JSON=""
R=$(rq 3100 vendor GET "/api/sa/support")
contains "سازنده تیکت مجموعه الف را در پنل می‌بیند" "مجموعه الف" "$R"
contains "متن تیکت در پنل سازنده دیده می‌شود" "قفل لایسنس" "$R"
JSON="{\"action\":\"reply\",\"body\":\"پاسخ پشتیبانی — پیگیری شد\"}"
R=$(rq 3100 vendor POST "/api/sa/support/$TID")
check "پاسخ سازنده ثبت شد" "True" "$(jget "$R" "str(d.get('error',''))==''")"
JSON=""
R=$(rq 3100 admina GET "/api/support/threads/$TID")
contains "مجموعه پاسخ پشتیبانی را می‌بیند" "پیگیری شد" "$R"

echo "═══ آیتم ۲۵ — صندوق پیام: پیام سازنده + خوانده‌نشده + دریافت ═══"
JSON="{\"audience\":\"ALL\",\"title\":\"اطلاعیه پذیرش\",\"body\":\"پیام آزمون صندوق\"}"
R=$(rq 3100 vendor POST /api/admin/messages)
check "پیام گروهی سازنده ارسال شد" "True" "$(jget "$R" "bool(d.get('ok') or d.get('message') or d.get('sent'))")"
JSON=""
R=$(rq 3100 adminb GET /api/messages)
contains "مجموعه فعال پیام را در صندوق می‌بیند" "اطلاعیه پذیرش" "$R"
MID=$(jget "$R" "d['messages'][0]['id'] if d.get('messages') else None")
if [ "$MID" != "(parse-error)" ] && [ "$MID" != "None" ] && [ -n "$MID" ]; then
  check "علامت‌گذاری خوانده‌شدن" "200" "$(code 3100 adminb POST "/api/messages/$MID/read")"
  R=$(rq 3100 adminb GET /api/messages)
  check "شمارش خوانده‌نشده پس از خواندن صفر شد" "0" "$(jget "$R" "d['unread']")"
else
  bad "پیام برای علامت‌گذاری یافت نشد"
fi

echo "═══ آیتم ۲۶ — بهداشت لاگ: هیچ کلید/رمزی در لاگ سرور ثبت نمی‌شود ═══"
LEAKS=0
for secret in "$SETUP_TOKEN" "$OWNER_SETUP_KEY" "$PASSWORD" "$INVITE_CODE"; do
  if grep -q "$secret" "$TMP/a.log" 2>/dev/null; then LEAKS=$((LEAKS+1)); fi
done
if grep -q "lic.pem" "$TMP/a.log" 2>/dev/null; then LEAKS=$((LEAKS+1)); fi
check "صفر نشتی رمز/کلید در لاگ سرور" "0" "$LEAKS"

echo "═══ آیتم ۲۷ — نصب تازه بدون سازنده: مهاجرت تمیز + اولین مجموعه با SETUP_TOKEN ═══"
DBB="$TMP/b.db"
B_PID=$(start_server b 3101 "$DBB" "") || bad "مهاجرت/بوت سرور B ناموفق"
if wait_up 3101; then
  ok "سرور دوم روی دیتابیس تازه بالا آمد"
  check "نصب تازه شناسایی شد" "True" "$(jget "$(rqn 3101 GET /api/license/status)" "d['freshInstall']")"
  JSON="{\"mobile\":\"$ADMIN_C_MOBILE\",\"name\":\"مدیر نصب تازه\",\"company\":\"نصب تازه\",\"password\":\"$PASSWORD\",\"setupToken\":\"$SETUP_TOKEN\"}"
  R=$(xreg 3101 198.51.100.8)
  check "اولین مجموعه با SETUP_TOKEN → ORG_ADMIN" "ORG_ADMIN" "$(jget "$R" "d['user']['role']")"
  check "ترِیال ۲۴ساعته نصب تازه" "True" "$(jget "$R" "d.get('trialEndsAt') is not None")"
  JSON=""
  curl -s --max-time 15 -X POST -H 'Content-Type: application/json' -d "{\"mobile\":\"$ADMIN_C_MOBILE\",\"password\":\"$PASSWORD\"}" -c "$TMP/cookie-c.txt" "http://127.0.0.1:3101/api/auth/login" >/dev/null
  R=$(curl -s --max-time 15 -b "$TMP/cookie-c.txt" "http://127.0.0.1:3101/api/auth/me")
  check "نصب بدون سازنده: مدیر، SUPER_ADMIN نمی‌شود" "False" "$(jget "$R" "d['user']['role']=='SUPER_ADMIN'")"
else
  bad "سرور B بالا نیامد"
  tail -10 "$TMP/b.log"
fi

ERR_500_A=$(grep -c "Internal server error" "$TMP/a.log" 2>/dev/null || true)
ERR_500_B=$(grep -c "Internal server error" "$TMP/b.log" 2>/dev/null || true)
check "لاگ سرور A بدون خطای داخلی ۵۰۰" "0" "$ERR_500_A"
check "لاگ سرور B بدون خطای داخلی ۵۰۰" "0" "$ERR_500_B"

kill_port 3100 >/dev/null 2>&1; kill_port 3101 >/dev/null 2>&1
kill "$A_PID" 2>/dev/null; [ -n "${B_PID:-}" ] && kill "$B_PID" 2>/dev/null

# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "══════════════ ماتریس پذیرش ══════════════"
echo "PASS: $PASS | FAIL: $FAIL"
echo "TMP: $TMP (لاگ‌ها نگه داشته شد)"
if [ "$FAIL" -eq 0 ]; then
  echo "ACCEPTANCE: ALL-PASS"
else
  echo "ACCEPTANCE: HAS-FAILURES"
  exit 1
fi
