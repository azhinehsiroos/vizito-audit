package ir.vizito.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.DownloadManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.splashscreen.SplashScreen;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * اکتیویتی اصلی ویزیتو — یک پوسته امن WebView که نسخه وب اپلیکیشن را بارگذاری می‌کند.
 * آدرس سرور در res/values/strings.xml (کلید server_url) تنظیم می‌شود.
 */
public class MainActivity extends AppCompatActivity {

    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_STORAGE = 1002;
    private static final int REQ_STORAGE_SAVE = 1003;

    /** زیرپوشه «Vizito» داخل پوشه عمومی Downloads — مقصد همه فایل‌های خروجی */
    private static final String VIZITO_SUBDIR = "Vizito";

    private WebView webView;
    private SwipeRefreshLayout swipeRefresh;
    private ProgressBar progressBar;
    private ValueCallback<Uri[]> filePathCallback;
    private String serverUrl;
    /** فقط این هاست مجاز به باز شدن داخل WebView است (ضد ریدایرکت مخرب و سوءاستفاده از پل جاوااسکریپت) */
    private String allowedHost = "";
    private boolean mainFrameFailed = false;

    private String pendingUrl, pendingAgent, pendingDisposition, pendingMime;
    private byte[] pendingSaveData;
    private String pendingSaveName;
    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor();

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        serverUrl = getString(R.string.server_url);
        Uri serverUri = Uri.parse(serverUrl);
        allowedHost = serverUri.getHost() == null ? "" : serverUri.getHost();
        webView = findViewById(R.id.web_view);
        swipeRefresh = findViewById(R.id.swipe_refresh);
        progressBar = findViewById(R.id.progress_bar);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        // امنیت: محتوای ناامن (HTTP داخل صفحه HTTPS) و دسترسی file:// مسدود می‌شود
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        webView.addJavascriptInterface(new WebAppBridge(), "AndroidBridge");

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        // امنیت: اپ تک‌دامینی است؛ کوکی شخص ثالث لازم نیست
        cm.setAcceptThirdPartyCookies(webView, false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(@NonNull WebView view, @NonNull WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
                if (scheme.equals("http") || scheme.equals("https")) {
                    // امنیت: فقط هاست سرور رسمی داخل اپ باز می‌شود؛ هر لینک دیگری در مرورگر خارجی باز می‌شود
                    String host = uri.getHost() == null ? "" : uri.getHost();
                    if (host.equalsIgnoreCase(allowedHost)) {
                        return false;
                    }
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (Exception ignored) {
                    }
                    return true;
                }
                // امنیت: schemeهای دلخواه باز نمی‌شوند — فقط لیست مجاز تماس/ایمیل/پیام/نقشه
                if (scheme.equals("tel") || scheme.equals("mailto") || scheme.equals("sms") || scheme.equals("geo")) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (Exception ignored) {
                    }
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                mainFrameFailed = false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                swipeRefresh.setRefreshing(false);
                progressBar.setVisibility(View.GONE);
                injectBlobDownloadShim();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request.isForMainFrame()) {
                    mainFrameFailed = true;
                    swipeRefresh.setRefreshing(false);
                    loadOfflinePage();
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (mainFrameFailed || newProgress >= 100) {
                    progressBar.setVisibility(View.GONE);
                } else {
                    progressBar.setVisibility(View.VISIBLE);
                    progressBar.setProgress(newProgress);
                }
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE_CHOOSER);
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });

        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            // دانلودهای blob: از طریق پل جاوااسکریپت (WebAppBridge) انجام می‌شوند
            if (url != null && url.startsWith("blob:")) {
                return;
            }
            prepareDownload(url, userAgent, contentDisposition, mimeType);
        });

        swipeRefresh.setOnRefreshListener(() -> {
            mainFrameFailed = false;
            webView.reload();
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                }
            }
        });

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(serverUrl);
        }
    }

    /** صفحه فارسی «اتصال برقرار نشد» برای زمانی که سرور در دسترس نیست */
    private void loadOfflinePage() {
        String html = "<!DOCTYPE html><html dir=\"rtl\" lang=\"fa\"><head><meta charset=\"utf-8\"/>"
                + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, maximum-scale=1\"/>"
                + "<style>*{box-sizing:border-box}body{margin:0;height:100vh;display:flex;align-items:center;"
                + "justify-content:center;background:#0c0a09;font-family:system-ui,-apple-system,sans-serif}"
                + ".card{text-align:center;padding:32px}.logo{width:88px;height:88px;margin:0 auto 22px;"
                + "border-radius:24px;background:linear-gradient(140deg,#e7c65a,#b8901f);display:flex;"
                + "align-items:center;justify-content:center;font-size:46px;font-weight:800;color:#0c0a09}"
                + "h1{font-size:20px;margin:0 0 12px;color:#d4af37}"
                + "p{font-size:14px;line-height:2;color:#a8a29e;margin:0 0 8px}"
                + "button{margin-top:26px;background:#d4af37;color:#0c0a09;border:none;border-radius:14px;"
                + "padding:13px 44px;font-size:15px;font-weight:700;font-family:inherit}</style></head><body>"
                + "<div class=\"card\"><div class=\"logo\">V</div><h1>اتصال برقرار نشد</h1>"
                + "<p>دسترسی به سرور ویزیتو امکان‌پذیر نیست.</p>"
                + "<p>لطفاً اتصال اینترنت یا آدرس سرور را بررسی کنید.</p>"
                + "<button onclick=\"location.replace('./')\">تلاش مجدد</button></div></body></html>";
        webView.loadDataWithBaseURL(serverUrl, html, "text/html", "utf-8", null);
    }

    /**
     * اسکریپت کمکی: دانلودهای تیپ blob (فاکتور PDF و فایل پشتیبان) را می‌گیرد
     * و بایت‌ها را به پل AndroidBridge می‌فرستد تا در پوشه Downloads/Vizito ذخیره شوند.
     */
    private void injectBlobDownloadShim() {
        webView.evaluateJavascript(
                "(function(){" +
                        "if(window.__vizitoShim)return;window.__vizitoShim=true;" +
                        "document.addEventListener('click',function(e){" +
                        "var a=e.target&&e.target.closest?e.target.closest('a[download]'):null;" +
                        "if(!a||!a.href||a.href.indexOf('blob:')!==0)return;" +
                        "e.preventDefault();e.stopPropagation();" +
                        "try{var x=new XMLHttpRequest();x.open('GET',a.href);x.responseType='arraybuffer';" +
                        "x.onload=function(){var b=new Uint8Array(x.response),c='';" +
                        "for(var i=0;i<b.length;i++)c+=String.fromCharCode(b[i]);" +
                        "window.AndroidBridge.saveBase64(btoa(c),a.download||('vizito-'+Date.now()+'.pdf'));};" +
                        "x.send();}catch(err){}},true);})();", null);
    }

    /** فقط صفحه‌ای که از هاست رسمی سرور بارگذاری شده مجاز به استفاده از پل است (ضد iframe/اسکریپت خارجی) */
    private boolean isTrustedPage() {
        if (webView == null || allowedHost == null || allowedHost.isEmpty()) return false;
        String url = webView.getUrl();
        if (url == null) return false;
        Uri u = Uri.parse(url);
        String host = u.getHost() == null ? "" : u.getHost();
        return host.equalsIgnoreCase(allowedHost);
    }

    /** پل جاوااسکریپت برای ذخیره فایل‌های تولیدشده در صفحه (PDF و پشتیبان) */
    private class WebAppBridge {
        @JavascriptInterface
        public void saveBase64(String base64, String fileName) {
            try {
                // امنیت: پل فقط از صفحه رسمی سرور قابل فراخوانی است — نه از iframe یا اسکریپت خارجی
                if (!isTrustedPage()) {
                    toastOnUiThread(getString(R.string.download_failed));
                    return;
                }
                // امنیت: فقط پسوندهای مجاز و حجم محدود — جلوی نوشتن فایل مخرب/عظیم در حافظه گرفته می‌شود
                String lower = fileName == null ? "" : fileName.toLowerCase();
                if (!lower.matches(".*\\.(pdf|json|csv|png|jpe?g|zip)$")) {
                    toastOnUiThread(getString(R.string.download_failed));
                    return;
                }
                if (fileName == null || fileName.length() > 100) {
                    toastOnUiThread(getString(R.string.download_failed));
                    return;
                }
                if (base64 == null || base64.length() > 30_000_000) { // ~۲۲MB باینری
                    toastOnUiThread(getString(R.string.download_failed));
                    return;
                }
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                saveBytes(data, sanitizeFileName(fileName));
            } catch (Exception e) {
                toastOnUiThread(getString(R.string.download_failed));
            }
        }
    }

    private void saveBytes(byte[] data, String fileName) {
        // اندروید ۹ و پایین‌تر: قبل از ذخیره در Downloads عمومی، دسترسی حافظه درخواست می‌شود
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                && ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                        != PackageManager.PERMISSION_GRANTED) {
            pendingSaveData = data;
            pendingSaveName = fileName;
            runOnUiThread(() -> ActivityCompat.requestPermissions(MainActivity.this,
                    new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE_SAVE));
            return;
        }
        ioExecutor.execute(() -> {
            try {
                String savedPath = writeToDownloads(data, fileName);
                toastOnUiThread(savedPath != null
                        ? getString(R.string.saved_to_vizito) + " " + savedPath
                        : getString(R.string.saved_to_app_storage));
            } catch (Exception e) {
                toastOnUiThread(getString(R.string.download_failed));
            }
        });
    }

    /**
     * ذخیره فایل در پوشه عمومی Downloads/ویزیتو.
     * در صورت موفقیت مسیر نمایشی (مثل Download/Vizito/report.pdf) برمی‌گردد،
     * در صورت افتادن به حافظه اختصاصی برنامه null برمی‌گرداند.
     */
    private String writeToDownloads(byte[] data, String fileName) throws Exception {
        String mime = guessMime(fileName);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
            values.put(MediaStore.Downloads.MIME_TYPE, mime);
            // فایل باید داخل زیرپوشه «Vizito» در Downloads ذخیره شود، نه ریشه Downloads
            values.put(MediaStore.Downloads.RELATIVE_PATH,
                    Environment.DIRECTORY_DOWNLOADS + "/" + VIZITO_SUBDIR);
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                writePrivate(data, fileName);
                return null;
            }
            try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                if (os == null) throw new Exception("output stream is null");
                os.write(data);
            }
            values.clear();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            getContentResolver().update(uri, values, null, null);
            return "Download/" + VIZITO_SUBDIR + "/" + fileName;
        } else {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    == PackageManager.PERMISSION_GRANTED) {
                File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                        VIZITO_SUBDIR);
                if (!dir.exists() && !dir.mkdirs()) {
                    writePrivate(data, fileName);
                    return null;
                }
                File f = uniqueFile(dir, fileName);
                try (FileOutputStream fos = new FileOutputStream(f)) {
                    fos.write(data);
                }
                // برای نمایش سریع در فایل‌منیجرها
                MediaScannerConnection.scanFile(this, new String[]{f.getAbsolutePath()},
                        new String[]{mime}, null);
                return "Download/" + VIZITO_SUBDIR + "/" + f.getName();
            }
            writePrivate(data, fileName);
            return null;
        }
    }

    /**
     * اندروید ۹ و پایین‌تر که MediaStore خودش نام تکراری را عوض نمی‌کند:
     * اگر فایل هم‌نام وجود داشته باشد شماره قبل از پسوند اضافه می‌شود (report (1).pdf).
     */
    private File uniqueFile(File dir, String fileName) {
        File f = new File(dir, fileName);
        if (!f.exists()) return f;
        String base = fileName;
        String ext = "";
        int dot = fileName.lastIndexOf('.');
        if (dot > 0) {
            base = fileName.substring(0, dot);
            ext = fileName.substring(dot);
        }
        for (int i = 1; i <= 999; i++) {
            f = new File(dir, base + " (" + i + ")" + ext);
            if (!f.exists()) return f;
        }
        return new File(dir, base + "-" + System.currentTimeMillis() + ext);
    }

    private void writePrivate(byte[] data, String fileName) throws Exception {
        File dir = getExternalFilesDir(null);
        if (dir == null) dir = getFilesDir();
        File f = new File(dir, fileName);
        try (FileOutputStream fos = new FileOutputStream(f)) {
            fos.write(data);
        }
    }

    /** فقط نام ساده فایل؛ جداکننده‌های مسیر و «..» حذف می‌شوند (ضد Path Traversal) */
    private String sanitizeFileName(String name) {
        String fallback = "vizito-" + System.currentTimeMillis() + ".pdf";
        if (name == null || name.trim().isEmpty()) return fallback;
        String n = name.replace('\\', '/').trim();
        int slash = n.lastIndexOf('/');
        if (slash >= 0) n = n.substring(slash + 1);
        n = n.replace("..", "_")
                .replaceAll("[\\x00-\\x1F<>:\"|?*]", "_")
                .trim();
        while (n.startsWith(".")) n = n.substring(1);
        if (n.isEmpty()) return fallback;
        return n;
    }

    private String guessMime(String fileName) {
        String n = fileName.toLowerCase();
        if (n.endsWith(".pdf")) return "application/pdf";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".zip")) return "application/zip";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".csv")) return "text/csv";
        return "application/octet-stream";
    }

    /** دانلود مستقیم با DownloadManager سیستم (لینک‌های معمولی http/https) */
    private void prepareDownload(String url, String userAgent, String contentDisposition, String mimeType) {
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P
                && ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            pendingUrl = url;
            pendingAgent = userAgent;
            pendingDisposition = contentDisposition;
            pendingMime = mimeType;
            ActivityCompat.requestPermissions(this,
                    new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
            return;
        }
        enqueueSystemDownload(url, userAgent, contentDisposition, mimeType);
    }

    private void enqueueSystemDownload(String url, String userAgent, String contentDisposition, String mimeType) {
        try {
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            if (userAgent != null) req.addRequestHeader("User-Agent", userAgent);
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null) req.addRequestHeader("Cookie", cookie);
            String fileName = sanitizeFileName(URLUtil.guessFileName(url, contentDisposition, mimeType));
            req.setMimeType(mimeType);
            req.setTitle(fileName);
            req.setDescription(getString(R.string.downloading_file));
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            // مقصد: زیرپوشه «Vizito» داخل پوشه عمومی Downloads
            File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                    VIZITO_SUBDIR);
            if (!dir.exists()) dir.mkdirs();
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,
                    VIZITO_SUBDIR + "/" + fileName);
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm != null) dm.enqueue(req);
            toastOnUiThread(getString(R.string.download_started_vizito)
                    + " Download/" + VIZITO_SUBDIR + "/" + fileName);
        } catch (Exception e) {
            toastOnUiThread(getString(R.string.download_failed));
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions,
                                           @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_STORAGE) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                enqueueSystemDownload(pendingUrl, pendingAgent, pendingDisposition, pendingMime);
            } else {
                Toast.makeText(this, R.string.storage_permission_needed, Toast.LENGTH_SHORT).show();
            }
            pendingUrl = null;
        } else if (requestCode == REQ_STORAGE_SAVE) {
            byte[] data = pendingSaveData;
            String name = pendingSaveName;
            pendingSaveData = null;
            pendingSaveName = null;
            if (data != null) {
                if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                    saveBytes(data, name);
                } else {
                    // بدون دسترسی، مثل قبل در حافظه اختصاصی برنامه ذخیره می‌شود
                    ioExecutor.execute(() -> {
                        try {
                            writePrivate(data, name);
                            toastOnUiThread(getString(R.string.saved_to_app_storage));
                        } catch (Exception e) {
                            toastOnUiThread(getString(R.string.download_failed));
                        }
                    });
                }
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE_CHOOSER && filePathCallback != null) {
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                results = new Uri[]{data.getData()};
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
        }
    }

    private void toastOnUiThread(String message) {
        runOnUiThread(() -> Toast.makeText(MainActivity.this, message, Toast.LENGTH_SHORT).show());
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        ioExecutor.shutdown();
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
