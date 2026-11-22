package com.pebblemeet.companion

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    private lateinit var store: CompanionStore

    private lateinit var tvAccessibilityStatus: TextView
    private lateinit var tvBridgeStatus: TextView
    private lateinit var tvWatchStatus: TextView
    private lateinit var btnToggleBridge: Button
    private lateinit var switchLocalOnly: SwitchCompat
    private lateinit var tvTransportHint: TextView
    private lateinit var tvPairingCode: TextView
    private lateinit var etRelayUrl: EditText
    private lateinit var layoutContactsList: LinearLayout

    private val statusListener: () -> Unit = { refreshUi() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        store = CompanionStore(this)

        tvAccessibilityStatus = findViewById(R.id.tvAccessibilityStatus)
        tvBridgeStatus = findViewById(R.id.tvBridgeStatus)
        tvWatchStatus = findViewById(R.id.tvWatchStatus)
        btnToggleBridge = findViewById(R.id.btnToggleBridge)
        switchLocalOnly = findViewById(R.id.switchLocalOnly)
        tvTransportHint = findViewById(R.id.tvTransportHint)
        tvPairingCode = findViewById(R.id.tvPairingCode)
        etRelayUrl = findViewById(R.id.etRelayUrl)
        layoutContactsList = findViewById(R.id.layoutContactsList)

        etRelayUrl.setText(store.relayUrl)
        switchLocalOnly.isChecked = store.localOnlyMode

        findViewById<Button>(R.id.btnOpenAccessibility).setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }

        btnToggleBridge.setOnClickListener {
            if (BridgeForegroundService.isRunning) {
                BridgeForegroundService.stop(this)
            } else {
                requestNotificationPermissionIfNeeded()
                BridgeForegroundService.start(this)
            }
        }

        switchLocalOnly.setOnCheckedChangeListener { _, isChecked ->
            store.localOnlyMode = isChecked
            if (BridgeForegroundService.isRunning) {
                BridgeForegroundService.reconnect(this)
            }
            refreshUi()
        }

        findViewById<Button>(R.id.btnCopyCode).setOnClickListener {
            val textToCopy = if (store.localOnlyMode) CompanionStore.LOCAL_WS_URL else store.formattedPairingCode()
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("PebbleMeet", textToCopy))
            Toast.makeText(this, "Copied $textToCopy", Toast.LENGTH_SHORT).show()
        }

        findViewById<Button>(R.id.btnRegenCode).setOnClickListener {
            store.regeneratePairingCode()
            if (BridgeForegroundService.isRunning && !store.localOnlyMode) {
                BridgeForegroundService.reconnect(this)
            }
            refreshUi()
            Toast.makeText(this, "Generated ${store.formattedPairingCode()}", Toast.LENGTH_SHORT).show()
        }

        findViewById<Button>(R.id.btnSaveRelay).setOnClickListener {
            val url = etRelayUrl.text.toString().trim()
            if (!url.startsWith("https://") && !url.startsWith("http://") && !url.startsWith("ws://") && !url.startsWith("wss://")) {
                Toast.makeText(this, "Enter a valid HTTPS or WSS URL", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            store.relayUrl = url
            if (BridgeForegroundService.isRunning && !store.localOnlyMode) {
                BridgeForegroundService.reconnect(this)
            }
            Toast.makeText(this, "Relay URL saved", Toast.LENGTH_SHORT).show()
        }

        val etName = findViewById<EditText>(R.id.etContactName)
        val etEmail = findViewById<EditText>(R.id.etContactEmail)
        val etRole = findViewById<EditText>(R.id.etContactRole)
        findViewById<Button>(R.id.btnAddContact).setOnClickListener {
            val name = etName.text.toString().trim()
            val email = etEmail.text.toString().trim()
            val role = etRole.text.toString().trim().ifEmpty { "Favorite" }
            if (name.isEmpty() || !email.contains("@")) {
                Toast.makeText(this, "Enter both name and valid email", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            val updated = store.getContacts() + QuickContact(name, email, role)
            store.saveContacts(updated)
            etName.setText("")
            etEmail.setText("")
            etRole.setText("")
            BridgeForegroundService.syncContacts(this)
            renderContacts()
            Toast.makeText(this, "Saved & synced to watch", Toast.LENGTH_SHORT).show()
        }

        findViewById<Button>(R.id.btnLaunchMeet).setOnClickListener {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://meet.google.com/new")))
        }

        renderContacts()
        refreshUi()
    }

    override fun onStart() {
        super.onStart()
        BridgeForegroundService.addStatusListener(statusListener)
        refreshUi()
    }

    override fun onStop() {
        BridgeForegroundService.removeStatusListener(statusListener)
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        refreshUi()
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                ActivityCompat.requestPermissions(
                    this,
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                    101
                )
            }
        }
    }

    private fun refreshUi() {
        val accEnabled = MeetAccessibilityService.instance != null
        tvAccessibilityStatus.text = if (accEnabled) {
            "Accessibility Service: Enabled (Vanadium & Meet ready)"
        } else {
            "Accessibility Service: Disabled — tap Accessibility below"
        }

        val running = BridgeForegroundService.isRunning
        val connected = BridgeForegroundService.relayConnected
        tvBridgeStatus.text = when {
            !running -> "Bridge Service: Stopped"
            store.localOnlyMode -> "Bridge Service: Listening on ${CompanionStore.LOCAL_WS_URL}"
            connected -> "Bridge Service: Connected to Cloudflare Relay"
            else -> "Bridge Service: Connecting to Relay..."
        }
        btnToggleBridge.text = if (running) "Stop Bridge" else "Start Bridge"

        tvWatchStatus.text = if (BridgeForegroundService.pebbleConnected) {
            "Pebble Watch: Connected"
        } else {
            "Pebble Watch: Open PebbleMeet on your watch"
        }

        if (store.localOnlyMode) {
            tvPairingCode.text = "127.0.0.1:8765"
            tvTransportHint.text =
                "Offline Mode: In PebbleMeet Settings -> Advanced, set Relay URL to ws://127.0.0.1:8765 (no pairing code needed)."
        } else {
            tvPairingCode.text = store.formattedPairingCode()
            tvTransportHint.text =
                "Enter this 6-character code in PebbleMeet Settings on your phone."
        }
    }

    private fun renderContacts() {
        layoutContactsList.removeAllViews()
        val contacts = store.getContacts()
        if (contacts.isEmpty()) {
            val empty = TextView(this).apply {
                text = "No favorite contacts saved yet."
                textSize = 12f
                setTextColor(0xFF525E70.toInt())
            }
            layoutContactsList.addView(empty)
            return
        }

        contacts.forEachIndexed { idx, contact ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, 8, 0, 8)
            }
            val label = TextView(this).apply {
                text = "${contact.name}\n${contact.email} · ${contact.role}"
                textSize = 13f
                setTextColor(0xFF111318.toInt())
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            }
            val removeBtn = Button(this).apply {
                text = "Remove"
                setOnClickListener {
                    val next = store.getContacts().filterIndexed { i, _ -> i != idx }
                    store.saveContacts(next)
                    BridgeForegroundService.syncContacts(this@MainActivity)
                    renderContacts()
                }
            }
            row.addView(label)
            row.addView(removeBtn)
            layoutContactsList.addView(row)
        }
    }
}
