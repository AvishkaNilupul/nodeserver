package com.redeemhub.seller

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout

/**
 * Thin native shell around the server-hosted seller app (/app). The UI itself
 * lives on the server, so app updates ship without rebuilding this APK.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var swipe: SwipeRefreshLayout
    private lateinit var errorView: LinearLayout

    private val appHost: String = Uri.parse(BuildConfig.BASE_URL).host ?: ""
    private var lastUrl: String = BuildConfig.BASE_URL
    private var pullWanted = true

    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private val fileChooser =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            filePathCallback?.onReceiveValue(
                WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            )
            filePathCallback = null
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Swap the splash launch theme for the regular one.
        setTheme(R.style.Theme_App)
        setContentView(R.layout.activity_main)

        web = findViewById(R.id.web)
        swipe = findViewById(R.id.swipe)
        errorView = findViewById(R.id.errorView)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            userAgentString = "$userAgentString RedeemHubApp/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(web, false)
        }
        web.addJavascriptInterface(Bridge(), "AppBridge")

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                val url = request.url
                val scheme = url.scheme ?: return false
                // Same-host http(s) stays inside the WebView.
                if ((scheme == "http" || scheme == "https") && url.host == appHost) return false
                // Everything else (other sites, tg://, https://t.me, mailto:)
                // goes to the matching external app.
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                    true
                } catch (e: ActivityNotFoundException) {
                    true // swallow: no handler installed
                }
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                lastUrl = url
                applyPullPolicy(url)
            }

            override fun onPageFinished(view: WebView, url: String) {
                swipe.isRefreshing = false
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError
            ) {
                if (request.isForMainFrame) {
                    swipe.isRefreshing = false
                    errorView.visibility = LinearLayout.VISIBLE
                }
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                return try {
                    fileChooser.launch(params.createIntent())
                    true
                } catch (e: ActivityNotFoundException) {
                    filePathCallback = null
                    false
                }
            }
        }

        // Pull-to-refresh: only when the page is scrolled to the top, and only
        // where the page hasn't opted out (the SPA disables it on the chat tab).
        swipe.setOnChildScrollUpCallback { _, _ -> web.scrollY > 0 }
        swipe.setColorSchemeColors(getColor(R.color.accent))
        swipe.setProgressBackgroundColorSchemeColor(getColor(R.color.surface))
        swipe.setOnRefreshListener {
            errorView.visibility = LinearLayout.GONE
            web.evaluateJavascript(
                "(function(){if(window.__appRefresh){window.__appRefresh();return 1}return 0})()"
            ) { handled ->
                if (handled != "1") web.reload()
            }
            // Failsafe: never leave the spinner stuck if the page misbehaves.
            swipe.postDelayed({ swipe.isRefreshing = false }, 8000)
        }

        findViewById<android.widget.Button>(R.id.retryBtn).setOnClickListener {
            errorView.visibility = LinearLayout.GONE
            web.loadUrl(lastUrl)
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
            }
        })

        if (savedInstanceState == null) {
            web.loadUrl(BuildConfig.BASE_URL)
        } else {
            web.restoreState(savedInstanceState)
        }
    }

    private fun applyPullPolicy(url: String) {
        // Desktop chat page manages its own scrolling; pulling there is jank.
        val isChat = url.contains("/admin.html")
        swipe.isEnabled = pullWanted && !isChat
    }

    inner class Bridge {
        @JavascriptInterface
        fun setPullToRefresh(enabled: Boolean) {
            runOnUiThread {
                pullWanted = enabled
                applyPullPolicy(lastUrl)
            }
        }

        @JavascriptInterface
        fun refreshDone() {
            runOnUiThread { swipe.isRefreshing = false }
        }

        @JavascriptInterface
        fun getVersion(): String = BuildConfig.VERSION_NAME
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onPause() {
        super.onPause()
        // Persist the session cookie so sellers stay signed in across app kills.
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }
}
