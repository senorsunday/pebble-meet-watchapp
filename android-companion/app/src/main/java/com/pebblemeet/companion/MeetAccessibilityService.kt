package com.pebblemeet.companion

import android.accessibilityservice.AccessibilityService
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Android AccessibilityService that controls Google Meet inside:
 *  - Vanadium (GrapheneOS browser) & Chromium/Gecko mobile browsers (meet.google.com)
 *  - Native Google Meet Android app (com.google.android.apps.tachyon / com.google.android.apps.meetings)
 *
 * Also streams live mute/camera/hand/recording/lobby state back to BridgeForegroundService.
 */
class MeetAccessibilityService : AccessibilityService() {

    private val mainHandler = Handler(Looper.getMainLooper())
    private val workerExecutor = Executors.newSingleThreadExecutor()
    private var stateDebounceScheduled = false
    private var lastRecording = false
    private var lastLobbyAlertAt = 0L

    @Volatile
    private var pendingInvite: PendingInvite? = null

    data class PendingInvite(
        val email: String,
        val name: String,
        val autoJoin: Boolean,
        val createdAt: Long = System.currentTimeMillis()
    )

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        BridgeForegroundService.onAccessibilityAvailabilityChanged(true)
        scheduleStateBroadcast()
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        if (instance === this) instance = null
        BridgeForegroundService.onAccessibilityAvailabilityChanged(false)
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        workerExecutor.shutdownNow()
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val pkg = event?.packageName?.toString() ?: return
        if (!isSupportedPackage(pkg)) return

        scheduleStateBroadcast()

        val invite = pendingInvite
        if (invite != null) {
            if (System.currentTimeMillis() - invite.createdAt > 120_000L) {
                pendingInvite = null
            } else if (hasActiveMeetUi() || findNodeByKeywords(listOf("join now", "ask to join")) != null) {
                pendingInvite = null
                runInviteFlow(invite.email, invite.name, invite.autoJoin)
            }
        }
    }

    override fun onInterrupt() {
        // No ongoing speech/feedback to interrupt
    }

    private fun isSupportedPackage(pkg: String): Boolean {
        if (pkg in KNOWN_MEET_PACKAGES) return true
        val lower = pkg.lowercase()
        return lower.contains("vanadium") ||
            lower.contains("chrome") ||
            lower.contains("chromium") ||
            lower.contains("cromite") ||
            lower.contains("firefox") ||
            lower.contains("fenix") ||
            lower.contains("ironfox") ||
            lower.contains("mull") ||
            lower.contains("brave") ||
            lower.contains("vivaldi") ||
            lower.contains("meet") ||
            lower.contains("tachyon")
    }

    private fun getCandidateRoots(): List<AccessibilityNodeInfo> {
        val roots = mutableListOf<AccessibilityNodeInfo>()
        try {
            for (win in windows) {
                val root = win.root ?: continue
                val pkg = root.packageName?.toString() ?: ""
                if (isSupportedPackage(pkg)) {
                    roots.add(root)
                }
            }
        } catch (_: Exception) {
        }
        val active = rootInActiveWindow
        if (active != null) {
            val pkg = active.packageName?.toString() ?: ""
            if (isSupportedPackage(pkg) && roots.none { it == active }) {
                roots.add(0, active)
            }
        }
        return roots
    }

    private fun collectNodes(root: AccessibilityNodeInfo, out: MutableList<AccessibilityNodeInfo>) {
        out.add(root)
        val count = root.childCount
        for (i in 0 until count) {
            val child = root.getChild(i) ?: continue
            collectNodes(child, out)
        }
    }

    private fun allNodes(): List<AccessibilityNodeInfo> {
        val result = mutableListOf<AccessibilityNodeInfo>()
        for (root in getCandidateRoots()) {
            collectNodes(root, result)
        }
        return result
    }

    private fun nodeLabel(node: AccessibilityNodeInfo): String {
        val desc = node.contentDescription?.toString()?.trim().orEmpty()
        val text = node.text?.toString()?.trim().orEmpty()
        return when {
            desc.isNotEmpty() && text.isNotEmpty() -> "$desc $text"
            desc.isNotEmpty() -> desc
            else -> text
        }.lowercase()
    }

    private fun findClickableAncestor(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        var cur = node
        var depth = 0
        while (cur != null && depth < 6) {
            if (cur.isClickable && cur.isEnabled) return cur
            cur = cur.parent
            depth += 1
        }
        return node
    }

    private fun findNodeByKeywords(
        keywords: List<String>,
        excludeKeywords: List<String> = emptyList(),
        requireClickable: Boolean = true
    ): AccessibilityNodeInfo? {
        val nodes = allNodes()
        for (kw in keywords) {
            val lowerKw = kw.lowercase()
            val match = nodes.firstOrNull { node ->
                if (!node.isVisibleToUser) return@firstOrNull false
                val label = nodeLabel(node)
                if (label.isEmpty() || !label.contains(lowerKw)) return@firstOrNull false
                if (excludeKeywords.any { ex -> label.contains(ex.lowercase()) }) return@firstOrNull false
                !requireClickable || findClickableAncestor(node)?.isClickable == true
            }
            if (match != null) return match
        }
        return null
    }

    private fun clickNode(node: AccessibilityNodeInfo?): Boolean {
        val target = findClickableAncestor(node) ?: return false
        return target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
    }

    private fun hasActiveMeetUi(): Boolean {
        return findNodeByKeywords(
            listOf(
                "leave call",
                "end call",
                "hang up",
                "turn off microphone",
                "turn on microphone",
                "mute",
                "unmute"
            )
        ) != null
    }

    private fun detectMicMuted(micNode: AccessibilityNodeInfo?): Boolean {
        if (micNode == null) return false
        val label = nodeLabel(micNode)
        if (label.contains("turn on microphone") || label.contains("unmute")) return true
        if (label.contains("turn off microphone") || (label.contains("mute") && !label.contains("unmute"))) {
            return micNode.isSelected || micNode.isChecked
        }
        return micNode.isSelected || micNode.isChecked
    }

    private fun detectCamOff(camNode: AccessibilityNodeInfo?): Boolean {
        if (camNode == null) return false
        val label = nodeLabel(camNode)
        if (label.contains("turn on camera") || label.contains("turn on video")) return true
        if (label.contains("turn off camera") || label.contains("turn off video")) return false
        return camNode.isSelected || camNode.isChecked
    }

    private fun detectHandRaised(handNode: AccessibilityNodeInfo?): Boolean {
        if (handNode == null) return false
        val label = nodeLabel(handNode)
        if (label.contains("lower hand")) return true
        return handNode.isSelected || handNode.isChecked
    }

    private fun scheduleStateBroadcast() {
        if (stateDebounceScheduled) return
        stateDebounceScheduled = true
        mainHandler.postDelayed({
            stateDebounceScheduled = false
            broadcastCurrentState()
        }, 250L)
    }

    fun broadcastCurrentState() {
        val micNode = findNodeByKeywords(
            listOf("turn off microphone", "turn on microphone", "unmute", "mute", "microphone")
        )
        val camNode = findNodeByKeywords(
            listOf("turn off camera", "turn on camera", "turn off video", "turn on video", "camera")
        )
        if (micNode == null && camNode == null) return

        val handNode = findNodeByKeywords(listOf("raise hand", "lower hand"))
        val muted = detectMicMuted(micNode)
        val camOff = detectCamOff(camNode)
        val handRaised = detectHandRaised(handNode)

        val recordingNode = findNodeByKeywords(
            keywords = listOf("recording"),
            excludeKeywords = listOf("start recording", "record meeting", "stop recording"),
            requireClickable = false
        )
        val isRecording = recordingNode != null

        if (isRecording && !lastRecording) {
            BridgeForegroundService.sendToWatch(
                JSONObject()
                    .put("type", "MEET_ALERT")
                    .put("kind", "recording")
                    .put("body", "Recording started (BACK)")
            )
        }
        lastRecording = isRecording

        val admitNode = findNodeByKeywords(listOf("admit"))
        val now = System.currentTimeMillis()
        if (admitNode != null && now - lastLobbyAlertAt > 15_000L) {
            lastLobbyAlertAt = now
            BridgeForegroundService.sendToWatch(
                JSONObject()
                    .put("type", "MEET_ALERT")
                    .put("kind", "lobby")
                    .put("body", "Guest waiting (SEL: Admit)")
            )
        }

        BridgeForegroundService.sendToWatch(
            JSONObject()
                .put("type", "MEET_STATE")
                .put("muted", muted)
                .put("cameraOn", !camOff)
                .put("handRaised", handRaised)
                .put("isRecording", isRecording)
                .put("participantCount", 2)
                .put("activeSpeaker", if (muted) "In Call" else "You")
        )
    }

    fun queuePendingInvite(email: String, name: String, autoJoin: Boolean) {
        pendingInvite = PendingInvite(email, name, autoJoin)
    }

    fun handleCommand(cmd: String, payload: JSONObject) {
        mainHandler.post {
            when (cmd) {
                "REQUEST_STATE" -> broadcastCurrentState()
                "TOGGLE_MUTE" -> {
                    val micNode = findNodeByKeywords(
                        listOf("turn off microphone", "turn on microphone", "unmute", "mute", "microphone")
                    )
                    if (micNode != null) {
                        val currentlyMuted = detectMicMuted(micNode)
                        val wantMuted = if (payload.has("muted")) payload.optBoolean("muted") else !currentlyMuted
                        if (currentlyMuted != wantMuted) {
                            clickNode(micNode)
                        }
                        mainHandler.postDelayed({ broadcastCurrentState() }, 200L)
                    }
                }
                "TOGGLE_CAMERA" -> {
                    val camNode = findNodeByKeywords(
                        listOf("turn off camera", "turn on camera", "turn off video", "turn on video", "camera")
                    )
                    if (camNode != null) {
                        val currentlyOn = !detectCamOff(camNode)
                        val wantOn = if (payload.has("cameraOn")) payload.optBoolean("cameraOn") else !currentlyOn
                        if (currentlyOn != wantOn) {
                            clickNode(camNode)
                        }
                        mainHandler.postDelayed({ broadcastCurrentState() }, 200L)
                    }
                }
                "RAISE_HAND" -> {
                    val handNode = findNodeByKeywords(listOf("raise hand", "lower hand"))
                    if (handNode != null) {
                        val currentlyRaised = detectHandRaised(handNode)
                        val wantRaised = if (payload.has("raised")) payload.optBoolean("raised") else !currentlyRaised
                        if (currentlyRaised != wantRaised) {
                            clickNode(handNode)
                        }
                        mainHandler.postDelayed({ broadcastCurrentState() }, 200L)
                    }
                }
                "TOGGLE_CAPTIONS" -> {
                    val capNode = findNodeByKeywords(listOf("turn on captions", "turn off captions", "captions"))
                    if (capNode != null) {
                        clickNode(capNode)
                    }
                }
                "ADMIT_GUEST" -> {
                    clickNode(findNodeByKeywords(listOf("admit")))
                }
                "END_CALL" -> {
                    clickNode(findNodeByKeywords(listOf("leave call", "end call", "hang up")))
                }
                "SEND_CHAT" -> {
                    val text = payload.optString("text").trim()
                    if (text.isNotEmpty()) {
                        runSendChatFlow(text)
                    }
                }
                "INVITE_CONTACT" -> {
                    val email = payload.optString("email").trim()
                    val name = payload.optString("callee", payload.optString("name", email)).trim()
                    if (email.isNotEmpty()) {
                        runInviteFlow(email, name, autoJoin = false)
                    }
                }
            }
        }
    }

    private fun runSendChatFlow(text: String) {
        workerExecutor.execute {
            try {
                var input = findEditableNode(listOf("send a message", "message"))
                if (input == null) {
                    val chatBtn = findNodeByKeywords(listOf("chat with everyone", "in-call messages", "chat"))
                    clickNode(chatBtn)
                    Thread.sleep(500L)
                    input = findEditableNode(listOf("send a message", "message"))
                }
                if (input == null) return@execute

                val args = Bundle().apply {
                    putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
                }
                input.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
                input.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
                Thread.sleep(200L)

                val sendBtn = findNodeByKeywords(listOf("send a message", "send"))
                clickNode(sendBtn)
            } catch (_: Exception) {
            }
        }
    }

    private fun runInviteFlow(email: String, name: String, autoJoin: Boolean) {
        workerExecutor.execute {
            val labelName = name.ifEmpty { email }
            try {
                // Wait up to 10s for Meet UI to load
                var waited = 0
                while (waited < 10_000 && !hasActiveMeetUi() && findNodeByKeywords(listOf("join now")) == null) {
                    Thread.sleep(300L)
                    waited += 300
                }

                if (autoJoin && !hasActiveMeetUi()) {
                    val joinBtn = findNodeByKeywords(listOf("join now"))
                    if (joinBtn != null) {
                        clickNode(joinBtn)
                        Thread.sleep(1500L)
                    }
                }

                // Open Add others / Add people
                var addBtn = findNodeByKeywords(listOf("add others", "add people"))
                if (addBtn == null) {
                    val peopleBtn = findNodeByKeywords(listOf("people", "show everyone", "participants"))
                    if (peopleBtn != null) {
                        clickNode(peopleBtn)
                        Thread.sleep(500L)
                        addBtn = findNodeByKeywords(listOf("add people", "add others"))
                    }
                }

                if (addBtn == null) {
                    sendInviteStatus(false, email, labelName, "Open Meet & tap Add People")
                    return@execute
                }
                clickNode(addBtn)
                Thread.sleep(600L)

                val emailInput = findEditableNode(listOf("enter name or email", "email", "search"))
                if (emailInput == null) {
                    sendInviteStatus(false, email, labelName, "Invite input not found")
                    return@execute
                }

                val args = Bundle().apply {
                    putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, email)
                }
                emailInput.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
                emailInput.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
                Thread.sleep(700L)

                // Tap autocomplete suggestion containing email
                val suggestion = findNodeByKeywords(listOf(email), requireClickable = true)
                if (suggestion != null && suggestion != emailInput) {
                    clickNode(suggestion)
                    Thread.sleep(400L)
                }

                val callBtn = findNodeByKeywords(listOf("call"))
                val sendEmailBtn = findNodeByKeywords(listOf("send email", "send invite"))
                val actionBtn = callBtn ?: sendEmailBtn

                if (actionBtn != null && clickNode(actionBtn)) {
                    val verb = if (actionBtn == callBtn) "Ringing" else "Invited"
                    sendInviteStatus(true, email, labelName, "$verb ${labelName.take(20)}")
                } else {
                    sendInviteStatus(false, email, labelName, "Confirm invite on phone")
                }
            } catch (_: Exception) {
                sendInviteStatus(false, email, labelName, "Invite failed on phone")
            }
        }
    }

    private fun findEditableNode(hintKeywords: List<String>): AccessibilityNodeInfo? {
        val nodes = allNodes()
        val editables = nodes.filter { it.isVisibleToUser && it.isEditable }
        for (kw in hintKeywords) {
            val lower = kw.lowercase()
            val match = editables.firstOrNull { node ->
                val combined = (nodeLabel(node) + " " + (node.hintText?.toString()?.lowercase() ?: ""))
                combined.contains(lower)
            }
            if (match != null) return match
        }
        return editables.firstOrNull()
    }

    private fun sendInviteStatus(ok: Boolean, email: String, name: String, message: String) {
        BridgeForegroundService.sendToWatch(
            JSONObject()
                .put("type", "INVITE_STATUS")
                .put("ok", ok)
                .put("email", email)
                .put("name", name)
                .put("message", message)
        )
    }

    companion object {
        @Volatile
        var instance: MeetAccessibilityService? = null
            private set

        private val KNOWN_MEET_PACKAGES = setOf(
            "app.vanadium.browser",
            "com.google.android.apps.tachyon",
            "com.google.android.apps.meetings",
            "com.android.chrome",
            "org.mozilla.firefox",
            "org.mozilla.fenix",
            "org.ironfoxoss.ironfox"
        )
    }
}
