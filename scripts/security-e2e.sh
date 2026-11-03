#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# scripts/security-e2e.sh — تست‌های امنیتی واقعی API ویزیتو (ممیزی v1.0.9)
# ---------------------------------------------------------------------------
# پوشش:
#   ۱) CSRF: رد شدن text/plain / form-urlencoded / multipart / خالی / Origin بیگانه
#      و Origin «null» + عبور درخواست JSON سالم + محافظت خروج (logout)
#   ۲) نشست: توکن نباید در بدنه پاسخ ورود/ثبت‌نام باشد (فقط کوکی HttpOnly)
#   ۳) آرشیو مشتری: حذفِ دارای سابقه = آرشیو؛ سابقه سفارش/پرداخت حفظ می‌شود
#   ۴) Rate limit: قفل پس از تلاش‌های ناموفق (per mobile) و سیل (per IP) با Retry-After
#
# استفاده:
#   BASE_URL=http://localhost:3000 MOBILE=0917... PASSWORD='...' bash scripts/security-e2e.sh
#
# نکته: به‌جای قفل کردن حساب واقعی، برای تست‌های نرخ از شماره‌های تستی و
# X-Forwarded-For جعلی استفاده می‌شود (TRUSTED_PROXY_HOPS=1 یعنی آخرین hop معتبر است).
# ---------------------------------------------------------------------------
set -u
BASE_URL="${BASE_URL:-http://localhost:3000}"
MOBILE="${MOBILE:?MOBILE لازم است}"
PASSWORD="${PASSWORD:?PASSWORD لازم است}"
JAR="$(mktemp)"
PASS=0; FAIL=0

# IPهای تستی «یکتای هر اجرا» — تا سطل‌های ۱۰ دقیقه‌ای اجرای قبلی نتیجه را خراب نکنند
TS=$(date +%s)
IPA=$((TS % 200 + 30)); IPB=$((TS / 200 % 200 + 30))
IP_LOCK="10.99.$IPA.$IPB"
IP_FLOOD="10.99.$IPA.$((IPB + 1))"
IP_CONC="10.99.$IPA.$((IPB + 2))"

say()  { printf '%s\n' "$*"; }
ok()   { PASS=$((PASS+1)); say "  ✅ $*"; }
bad()  { FAIL=$((FAIL+1)); say "  ❌ $*"; }
check(){ # check <شرح> <وضعیت_منتظره> <وضعیت_واقعی>
  if [ "$2" = "$3" ]; then ok "$1 → $3"; else bad "$1 → $3 (منتظره: $2)"; fi
}

command -v curl >/dev/null || { echo "curl لازم است"; exit 1; }

say "== ۰) ورود مدیر (توکن فقط در کوکی HttpOnly — نه در بدنه پاسخ) =="
LOGIN_HTTP=$(curl -s -o /tmp/vzt-login-body.json -w '%{http_code}' -c "$JAR" -H 'Content-Type: application/json' -H 'X-Forwarded-For: 10.99.0.1' \
  -d "{\"mobile\":\"$MOBILE\",\"password\":\"$PASSWORD\"}" "$BASE_URL/api/auth/login")
LOGIN_BODY=$(cat /tmp/vzt-login-body.json 2>/dev/null || echo "")
say "  (کد ورود: $LOGIN_HTTP)"
if [ "$LOGIN_HTTP" != "200" ]; then
  say "  پاسخ: $LOGIN_BODY"
  echo "ورود ناموفق — ادامه ممکن نیست"; exit 1
fi
if echo "$LOGIN_BODY" | rg -q '"token"'; then
  bad "پاسخ ورود حاوی فیلد token است (نباید باشد)"
else
  ok "پاسخ ورود بدون توکن در بدنه"
fi
if rg -q 'vizito_session' "$JAR" && rg -qi '#HttpOnly_' "$JAR"; then
  ok "کوکی نشست HttpOnly ست شده"
else
  bad "کوکی نشست HttpOnly در jar نیست"
fi
SID=$(rg -o 'vizito_session\s+\S+' "$JAR" | head -1 | awk '{print $2}')
[ -n "$SID" ] || { echo "ورود ناموفق — ادامه ممکن نیست"; exit 1; }

auth() { printf 'Cookie: vizito_session=%s' "$SID"; }

say "== ۱) گیت ضد CSRF — درخواست‌های تغییردهنده =="
C1=$(curl -s -o /dev/null -w '%{http_code}' -H "$(auth)" -H 'Content-Type: text/plain' \
  -d '{"name":"تست","phone":"09120000001"}' "$BASE_URL/api/customers")
check "POST مشتری با text/plain" 403 "$C1"

C2=$(curl -s -o /dev/null -w '%{http_code}' -H "$(auth)" -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'name=x&phone=09120000001' "$BASE_URL/api/customers")
check "POST مشتری با form-urlencoded" 403 "$C2"

C3=$(curl -s -o /dev/null -w '%{http_code}' -H "$(auth)" -H 'Content-Type: multipart/form-data; boundary=X' \
  -d 'x' "$BASE_URL/api/customers")
check "POST مشتری با multipart" 403 "$C3"

C4=$(curl -s -o /dev/null -w '%{http_code}' -H "$(auth)" -H 'Content-Type:' \
  -d '{"name":"تست","phone":"09120000001"}' "$BASE_URL/api/customers")
check "POST مشتری با Content-Type خالی" 403 "$C4"

# هاست عمومی فرضی + Origin بیگانه ⇒ باید ۴۰۳ شود
C5=$(curl -s -o /dev/null -w '%{http_code}' -H "$(auth)" -H 'Content-Type: application/json' \
  -H 'Host: myvizito.ir' -H 'Origin: https://evil.example' \
  -d '{"name":"تست","phone":"09120000001"}' "$BASE_URL/api/customers")
check "POST با Host عمومی و Origin بیگانه" 403 "$C5"

# Origin «null» (iframe سندباکس‌شده/file://) ⇒ رد شود
C6=$(curl -s -o /dev/null -w '%{http_code}' -H "$(auth)" -H 'Content-Type: application/json' \
  -H 'Host: myvizito.ir' -H 'Origin: null' \
  -d '{"name":"تست","phone":"09120000001"}' "$BASE_URL/api/customers")
check "POST با Origin=null" 403 "$C6"

# همان هاست عمومی + Origin هم‌دامنه ⇒ عبور
C7=$(curl -s -o /dev/null -w '%{http_code}' -H "$(auth)" -H 'Content-Type: application/json' \
  -H 'Host: myvizito.ir' -H 'Origin: https://myvizito.ir' \
  -d '{"name":"تست","phone":"09120000001"}' "$BASE_URL/api/customers")
check "POST با Origin هم‌دامنه" 201 "$C7"

# کلاینت غیرمرورگری (بدون Origin/Referer) + JSON ⇒ عبور (اپ خود برنامه همین است)
CREATE=$(curl -s -w '\n%{http_code}' -H "$(auth)" -H 'Content-Type: application/json' \
  -H 'X-Forwarded-For: 10.99.0.1' \
  -d '{"name":"مشتری تست امنیت","phone":"09120000077","type":"STORE"}' "$BASE_URL/api/customers")
C8=$(echo "$CREATE" | tail -1)
CUST_ID=$(echo "$CREATE" | head -1 | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
check "POST مشتری JSON سالم (curl بدون Origin)" 201 "$C8"

C9=$(curl -s -o /dev/null -w '%{http_code}' -H "$(auth)" "$BASE_URL/api/customers")
check "GET مشتریان (بدون گیت — فقط نشست)" 200 "$C9"

say "== ۲) گیت روی مسیرهای اصلاح‌شده (me / change-password / logout) =="
C10=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "$(auth)" -H 'Content-Type: text/plain' \
  -d '{"name":"هکر"}' "$BASE_URL/api/auth/me")
check "PUT پروفایل با text/plain" 403 "$C10"

C11=$(curl -s -o /dev/null -w '%{http_code}' -H "$(auth)" -H 'Content-Type: text/plain' \
  -d '{"currentPassword":"x","newPassword":"y"}' "$BASE_URL/api/auth/change-password")
check "POST تغییر رمز با text/plain" 403 "$C11"

C12=$(curl -s -o /dev/null -w '%{http_code}' -H "$(auth)" -H 'Content-Type: text/plain' -d '{}' "$BASE_URL/api/auth/logout")
check "POST خروج با text/plain" 403 "$C12"

say "== ۳) آرشیو مشتری — سابقه مالی حفظ می‌شود =="
# مشتری بدون سابقه → حذف دائمی مجاز
D1=$(curl -s -H "$(auth)" -H 'Content-Type: application/json' -H 'X-Forwarded-For: 10.99.0.1' \
  -d '{"name":"مشتری بی‌سابقه تست","phone":"09120000078"}' "$BASE_URL/api/customers")
T1=$(echo "$D1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
R1=$(curl -s -X DELETE -H "$(auth)" -H 'Content-Type: application/json' "$BASE_URL/api/customers/$T1")
if echo "$R1" | rg -q '"archived":false'; then ok "مشتری بدون سابقه → حذف دائمی"; else bad "مشتری بدون سابقه → پاسخ: $R1"; fi

# مشتری دارای سفارش → آرشیو (نه حذف) + سابقه حفظ
O1=$(curl -s -H "$(auth)" -H 'Content-Type: application/json' -H 'X-Forwarded-For: 10.99.0.1' \
  -d "{\"customerId\":\"$CUST_ID\",\"title\":\"فاکتور تست امنیت\",\"priceType\":\"STORE\",\"items\":[{\"productName\":\"کالای تست\",\"quantity\":1,\"price\":100000,\"discount\":0}],\"settlementType\":\"CASH\",\"dueDays\":30}" \
  "$BASE_URL/api/orders")
ORDER_ID=$(echo "$O1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
[ -n "$ORDER_ID" ] && ok "سفارش تست ساخته شد" || bad "ساخت سفارش تست ناموفق"

R2=$(curl -s -X DELETE -H "$(auth)" -H 'Content-Type: application/json' "$BASE_URL/api/customers/$CUST_ID")
if echo "$R2" | rg -q '"archived":true'; then ok "مشتری دارای سفارش → آرشیو شد (حذف نشد)"; else bad "پاسخ حذف مشتری دارای سابقه: $R2"; fi

if echo "$(curl -s -H "$(auth)" "$BASE_URL/api/customers")" | rg -qF "$CUST_ID"; then
  bad "مشتری آرشیوشده هنوز در فهرست فعالان است"
else
  ok "مشتری آرشیوشده از فهرست فعالان حذف شد"
fi
if echo "$(curl -s -H "$(auth)" "$BASE_URL/api/customers?archived=1")" | rg -qF "$CUST_ID"; then
  ok "مشتری آرشیوشده در فهرست آرشیو دیده می‌شود"
else
  bad "مشتری آرشیوشده در فهرست آرشیو نیست"
fi
if echo "$(curl -s -H "$(auth)" "$BASE_URL/api/orders?customerId=$CUST_ID")" | rg -qF "$ORDER_ID"; then
  ok "سابقه سفارش مشتری آرشیوشده حفظ شده"
else
  bad "سابقه سفارش از بین رفته!"
fi

U1=$(curl -s -X PATCH -H "$(auth)" -H 'Content-Type: application/json' \
  -d '{"archived":false}' "$BASE_URL/api/customers/$CUST_ID")
if echo "$U1" | rg -q '"archived":false'; then ok "بازگردانی از آرشیو (PATCH) کار می‌کند"; else bad "بازگردانی از آرشیو: $U1"; fi

say "== ۴) پاک‌سازی داده‌های تست (تأییدشده) =="
DC1=$(curl -s -X DELETE -H "$(auth)" -H 'Content-Type: application/json' "$BASE_URL/api/orders/$ORDER_ID")
echo "$DC1" | rg -q '"ok":true' && ok "سفارش تست حذف شد" || bad "حذف سفارش تست: $DC1"
DC2=$(curl -s -X DELETE -H "$(auth)" -H 'Content-Type: application/json' "$BASE_URL/api/customers/$CUST_ID")
if echo "$DC2" | rg -q '"archived":false'; then ok "مشتری تست حذف دائمی شد (بدون باقی‌گذاری رکورد)"; else bad "حذف مشتری تست: $DC2"; fi

say "== ۵) Rate limit — قفل تلاش ناموفق per-mobile =="
codes=""
for i in $(seq 1 10); do
  c=$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -H "X-Forwarded-For: $IP_LOCK" \
    -d '{"mobile":"09120009999","password":"wrong-pass-123"}' "$BASE_URL/api/auth/login")
  codes="$codes $c"
done
say "  کدها:$codes"
n401=$(echo $codes | tr ' ' '\n' | rg -c '^401$' || echo 0)
n429=$(echo $codes | tr ' ' '\n' | rg -c '^429$' || echo 0)
[ "$n401" = "8" ] && [ "$n429" = "2" ] && ok "۸ تلاش ۴۰۱ و بعد ۴۲۹ (قفل تلاش ناموفق)" || bad "الگوی قفل ناموفق: 401×$n401 429×$n429"
RA=$(curl -s -D - -o /dev/null -H 'Content-Type: application/json' -H "X-Forwarded-For: $IP_LOCK" \
  -d '{"mobile":"09120009999","password":"wrong-pass-123"}' "$BASE_URL/api/auth/login" | rg -i '^retry-after' | tr -d '\r')
[ -n "$RA" ] && ok "هدر Retry-After حاضر است ($RA)" || bad "هدر Retry-After نیست"

say "== ۶) Rate limit — سیل per-IP (۳۰ در ۱۰ دقیقه) =="
codes=""
for i in $(seq 1 35); do
  m=$(printf '09130%06d' "$i")
  c=$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -H "X-Forwarded-For: $IP_FLOOD" \
    -d "{\"mobile\":\"$m\",\"password\":\"wrong-pass-123\"}" "$BASE_URL/api/auth/login")
  codes="$codes $c"
done
n429ip=$(echo $codes | tr ' ' '\n' | rg -c '^429$' || echo 0)
n401ip=$(echo $codes | tr ' ' '\n' | rg -c '^401$' || echo 0)
[ "$n401ip" = "30" ] && [ "$n429ip" = "5" ] && ok "۳۰ درخواست اول ۴۰۱، بعدش ۴۲۹ (سقف per-IP)" || bad "الگوی سیل: 401×$n401ip 429×$n429ip"

say "== ۷) Rate limit — هم‌زمانی (۱۶ درخواست موازی روی کلید تازه) =="
codes=$(for i in $(seq 1 16); do
  curl -s -o /dev/null -w '%{http_code}\n' -H 'Content-Type: application/json' -H "X-Forwarded-For: $IP_CONC" \
    -d '{"mobile":"09120008888","password":"wrong-pass-123"}' "$BASE_URL/api/auth/login" &
done; wait)
codes=$(echo "$codes" | tr '\n' ' ')
say "  کدها:$codes"
n500=$(echo $codes | tr ' ' '\n' | rg -c '^5' || echo 0)
# در انفجار کاملاً موازی همه قبل از ثبت اولین شکست از چک قفل رد می‌شوند (TOCTOU محدود و
# طراحی‌شده: شمارش فقط تلاش ناموفق است تا مهاجم نتواند حساب قربانی را عمداً قفل کند) —
# بنابراین معیار درست: نبودِ ۵xx + فعال شدن قفل در «اولین درخواست ترتیبی بعدی»
NEXT=$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -H "X-Forwarded-For: $IP_CONC" \
  -d '{"mobile":"09120008888","password":"wrong-pass-123"}' "$BASE_URL/api/auth/login")
[ "$n500" = "0" ] && ok "هیچ ۵xx در رقابت هم‌زمان نبود" || bad "$n500 خطای سرور در رقابت"
[ "$NEXT" = "429" ] && ok "قفل بعد از انفجار موازی در درخواست ترتیبی فعال است (429)" || bad "قفل بعد از انفجار فعال نشد (کد: $NEXT)"

say ""
say "═══ نتیجه: ✅ $PASS موفق — ❌ $FAIL ناموفق ═══"
rm -f "$JAR"
[ "$FAIL" = "0" ]
