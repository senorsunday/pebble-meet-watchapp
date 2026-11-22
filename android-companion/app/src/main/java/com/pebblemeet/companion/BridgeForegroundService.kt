package com.pebblemeet.companion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/**
 * Foreground Service bridging PebbleKit JS <-> MeetAccessibilityService.
 *
 * Supports two transport modes:
 *  1. Cloudflare Durable Object Relay (default, 6-char pairing code, zero phone config)
 *  2. Local-Only Loopback Server (`ws://127.0.0.1:8765`, 100% offline / zero cloud)
 */
class BridgeForegroundService : Service() {

    private lateinit var store: CompanionStore
    private val mainHandler = Handler(Looper.getMainLooper())
    private val httpClient = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private var relayWs: WebSocket? = null
    private var localServer: LocalWsServer? = null
    private var reconnectDelayMs = 2000L
    private var reconnectRunnable: Runnable? = null

    override fun onCreate() {
        super.onCreate()
        store = CompanionStore(this)
        instance = this
        ensureNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopBridge()
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_SYNC_CONTACTS -> {
                broadcastContacts()
                return START_STICKY
            }
            ACTION_RECONNECT -> {
                startForeground(NOTIFICATION_ID, buildNotification())
                restartTransport()
                return START_STICKY
            }
            else -> {
                startForeground(NOTIFICATION_ID, buildNotification())
                restartTransport()
                return START_STICKY
            }
        }
    }

    override fun onDestroy() {
        stopBridge()
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun stopBridge() {
        reconnectRunnable?.let { mainHandler.removeCallbacks(it) }
        reconnectRunnable = null
        relayWs?.close(1000, "Service stopped")
        relayWs = null
        localServer?.stop()
        localServer = null
        isRunning = false
        relayConnected = false
        pebbleConnected = false
        notifyStatusListeners()
    }

    private fun restartTransport() {
        stopBridge()
        isRunning = true

        if (store.localOnlyMode) {
            try {
                localServer = LocalWsServer(
                    port = CompanionStore.LOCAL_WS_PORT,
                    onMessage = { raw -> handleIncomingJson(raw) },
                    onClientCountChanged = { count ->
                        relayConnected = true
                        pebbleConnected = count > 0
                        if (pebbleConnected) {
                            broadcastContacts()
                            MeetAccessibilityService.instance?.broadcastCurrentState()
                        }
                        updateNotification()
                        notifyStatusListeners()
                    }
                ).apply { start() }
                relayConnected = true
            } catch (_: Exception) {
                relayConnected = false
            }
        } else {
            connectToCloudflareRelay()
        }

        updateNotification()
        notifyStatusListeners()
    }

    private fun connectToCloudflareRelay() {
        val code = store.pairingCode
        val base = store.relayUrl
        val wsUrl = if (base.startsWith("ws://") || base.startsWith("wss://")) {
            val sep = if (base.contains("?")) "&" else "?"
            "$base${sep}room=${URLEncoder.encode(code, "UTF-8")}&role=chrome"
        } else {
            val wsBase = base.replace(Regex("^https://"), "wss://").replace(Regex("^http://"), "ws://")
            "$wsBase/bridge/ws?room=${URLEncoder.encode(code, "UTF-8")}&role=chrome"
        }

        val request = Request.Builder().url(wsUrl).build()
        relayWs = httpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                reconnectDelayMs = 2000L
                relayConnected = true
                broadcastContacts()
                MeetAccessibilityService.instance?.broadcastCurrentState()
                updateNotification()
                notifyStatusListeners()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleIncomingJson(text)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                relayWs = null
                relayConnected = false
                pebbleConnected = false
                updateNotification()
                notifyStatusListeners()
                if (isRunning && !store.localOnlyMode) scheduleReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                relayWs = null
                relayConnected = false
                pebbleConnected = false
                updateNotification()
                notifyStatusListeners()
                if (isRunning && !store.localOnlyMode) scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        if (reconnectRunnable != null) return
        val runnable = Runnable {
            reconnectRunnable = null
            if (isRunning && !store.localOnlyMode) {
                connectToCloudflareRelay()
            }
        }
        reconnectRunnable = runnable
        mainHandler.postDelayed(runnable, reconnectDelayMs)
        reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(30_000L)
    }

    private fun handleIncomingJson(raw: String) {
        val msg = try {
            JSONObject(raw)
        } catch (_: Exception) {
            return
        }

        if (msg.optString("type") == "BRIDGE_PRESENCE") {
            pebbleConnected = msg.optBoolean("pebbleConnected", false)
            if (pebbleConnected) {
                broadcastContacts()
                MeetAccessibilityService.instance?.broadcastCurrentState()
            }
            updateNotification()
            notifyStatusListeners()
            return
        }

        val cmd = msg.optString("cmd")
        if (cmd.isEmpty()) return

        when (cmd) {
            "NEW_MEET" -> openMeetUrl("https://meet.google.com/new")
            "OPEN_MEET" -> {
                val url = msg.optString("url", "https://meet.google.com/new")
                val safeUrl = if (url.startsWith("https://meet.google.com/")) url else "https://meet.google.com/new"
                openMeetUrl(safeUrl)
            }
            "CALL_CONTACT" -> {
                val email = msg.optString("email").trim()
                val name = msg.optString("callee", msg.optString("name", email)).trim()
                if (email.isEmpty()) {
                    sendJson(
                        JSONObject()
                            .put("type", "INVITE_STATUS")
                            .put("ok", false)
                            .put("message", "No email saved for $name")
                    )
                } else {
                    MeetAccessibilityService.instance?.queuePendingInvite(email, name, autoJoin = true)
                    openMeetUrl("https://meet.google.com/new")
                }
            }
            "REQUEST_STATE" -> {
                broadcastContacts()
                MeetAccessibilityService.instance?.handleCommand(cmd, msg)
            }
            else -> {
                val service = MeetAccessibilityService.instance
                if (service == null) {
                    sendJson(
                        JSONObject()
                            .put("type", "MEET_ALERT")
                            .put("kind", "generic")
                            .put("body", "Enable PebbleMeet Accessibility")
                    )
                } else {
                    service.handleCommand(cmd, msg)
                }
            }
        }
    }

    private fun openMeetUrl(url: String) {
        try {
            val viewIntent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(viewIntent)
        } catch (_: Exception) {
            sendJson(
                JSONObject()
                    .put("type", "MEET_ALERT")
                    .put("kind", "generic")
                    .put("body", "Could not open Meet URL")
            )
        }
    }

    private fun broadcastContacts() {
        val contacts = store.getContacts()
        val arr = JSONArray()
        contacts.forEach { c ->
            arr.put(
                JSONObject()
                    .put("name", c.name)
                    .put("email", c.email)
                    .put("role", c.role)
            )
        }
        sendJson(JSONObject().put("type", "CONTACTS_SYNC").put("contacts", arr))
    }

    fun sendJson(obj: JSONObject): Boolean {
        val text = obj.toString()
        return if (store.localOnlyMode) {
            localServer?.broadcast(text) ?: false
        } else {
            relayWs?.send(text) ?: false
        }
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "PebbleMeet Bridge",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps your Pebble smartwatch paired with Google Meet on this phone"
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm?.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val openIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val modeLabel = if (store.localOnlyMode) {
            "Local ws://127.0.0.1:${CompanionStore.LOCAL_WS_PORT}"
        } else {
            "Room ${store.formattedPairingCode()}"
        }
        val watchState = if (pebbleConnected) "Pebble connected" else "Waiting for Pebble"

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("PebbleMeet Bridge Active")
            .setContentText("$modeLabel · $watchState")
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .build()
    }

    private fun updateNotification() {
        if (!isRunning) return
        val nm = getSystemService(NotificationManager::class.java)
        nm?.notify(NOTIFICATION_ID, buildNotification())
    }

    companion object {
        const val ACTION_START = "com.pebblemeet.companion.START"
        const val ACTION_STOP = "com.pebblemeet.companion.STOP"
        const val ACTION_RECONNECT = "com.pebblemeet.companion.RECONNECT"
        const val ACTION_SYNC_CONTACTS = "com.pebblemeet.companion.SYNC_CONTACTS"

        private const val CHANNEL_ID = "pebblemeet_bridge_channel"
        private const val NOTIFICATION_ID = 1001

        @Volatile
        private var instance: BridgeForegroundService? = null

        @Volatile
        var isRunning: Boolean = false
            private set

        @Volatile
        var relayConnected: Boolean = false
            private set

        @Volatile
        var pebbleConnected: Boolean = false
            private set

        private val statusListeners = mutableSetOf<() -> Unit>()

        fun addStatusListener(listener: () -> Unit) {
            statusListeners.add(listener)
        }

        fun removeStatusListener(listener: () -> Unit) {
            statusListeners.remove(listener)
        }

        fun onAccessibilityAvailabilityChanged(enabled: Boolean) {
            if (enabled) {
                MeetAccessibilityService.instance?.broadcastCurrentState()
            }
            notifyStatusListeners()
        }

        private fun notifyStatusListeners() {
            val main = Handler(Looper.getMainLooper())
            main.post {
                statusListeners.toList().forEach { it() }
            }
        }

        fun sendToWatch(obj: JSONObject): Boolean = instance?.sendJson(obj) ?: false

        fun start(context: Context) {
            val intent = Intent(context, BridgeForegroundService::class.java).setAction(ACTION_START)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            val intent = Intent(context, BridgeForegroundService::class.java).setAction(ACTION_STOP)
            context.startService(intent)
        }

        fun reconnect(context: Context) {
            if (!isRunning) {
                start(context)
                return
            }
            val intent = Intent(context, BridgeForegroundService::class.java).setAction(ACTION_RECONNECT)
            context.startService(intent)
        }

        fun syncContacts(context: Context) {
            if (!isRunning) return
            val intent = Intent(context, BridgeForegroundService::class.java).setAction(ACTION_SYNC_CONTACTS)
            context.startService(intent)
        }
    }
}
