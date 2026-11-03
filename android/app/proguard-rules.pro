# قوانین ProGuard ویزیتو
# پل جاوااسکریپت WebView نباید کوتاه/حذف شود وگرنه AndroidBridge از JS در دسترس نیست

-keepattributes JavascriptInterface
-keepclassmembers class ir.vizito.app.MainActivity$WebAppBridge {
    public *;
}
-keep class ir.vizito.app.MainActivity$* { *; }

# Splash screen و layouts داخلی
-keep class ir.vizito.app.R$* { *; }
