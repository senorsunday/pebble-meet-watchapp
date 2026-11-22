package com.pebblemeet.companion

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom

data class QuickContact(
    val name: String,
    val email: String,
    val role: String = "Favorite"
)

class CompanionStore(context: Context) {

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    var pairingCode: String
        get() {
            val saved = normalizeCode(prefs.getString(KEY_PAIRING_CODE, "") ?: "")
            if (saved.length >= 6) return saved
            val generated = generatePairingCode()
            prefs.edit().putString(KEY_PAIRING_CODE, generated).apply()
            return generated
        }
        set(value) {
            prefs.edit().putString(KEY_PAIRING_CODE, normalizeCode(value)).apply()
        }

    var relayUrl: String
        get() = (prefs.getString(KEY_RELAY_URL, DEFAULT_RELAY_URL) ?: DEFAULT_RELAY_URL)
            .trim()
            .trimEnd('/')
        set(value) {
            prefs.edit().putString(KEY_RELAY_URL, value.trim().trimEnd('/')).apply()
        }

    var localOnlyMode: Boolean
        get() = prefs.getBoolean(KEY_LOCAL_ONLY, false)
        set(value) {
            prefs.edit().putBoolean(KEY_LOCAL_ONLY, value).apply()
        }

    fun formattedPairingCode(): String {
        val code = pairingCode
        return if (code.length == 6) "${code.substring(0, 3)}-${code.substring(3)}" else code
    }

    fun regeneratePairingCode(): String {
        val code = generatePairingCode()
        pairingCode = code
        return code
    }

    fun getContacts(): List<QuickContact> {
        val raw = prefs.getString(KEY_CONTACTS, "[]") ?: "[]"
        return try {
            val arr = JSONArray(raw)
            val list = mutableListOf<QuickContact>()
            for (i in 0 until arr.length()) {
                val obj = arr.optJSONObject(i) ?: continue
                val name = obj.optString("name").trim()
                val email = obj.optString("email").trim()
                val role = obj.optString("role", "Favorite").trim().ifEmpty { "Favorite" }
                if (name.isNotEmpty() || email.isNotEmpty()) {
                    list.add(QuickContact(name.take(30), email.take(46), role.take(26)))
                }
            }
            list
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun saveContacts(contacts: List<QuickContact>) {
        val arr = JSONArray()
        contacts.take(16).forEach { c ->
            arr.put(
                JSONObject()
                    .put("name", c.name.take(30))
                    .put("email", c.email.take(46))
                    .put("role", c.role.take(26))
            )
        }
        prefs.edit().putString(KEY_CONTACTS, arr.toString()).apply()
    }

    companion object {
        const val DEFAULT_RELAY_URL = "https://pebble-meet-watchapp-oauth.apalson.workers.dev"
        const val LOCAL_WS_PORT = 8765
        const val LOCAL_WS_URL = "ws://127.0.0.1:$LOCAL_WS_PORT"

        private const val PREFS_NAME = "pebblemeet_companion_prefs"
        private const val KEY_PAIRING_CODE = "pairing_code"
        private const val KEY_RELAY_URL = "relay_url"
        private const val KEY_LOCAL_ONLY = "local_only_mode"
        private const val KEY_CONTACTS = "quick_contacts"
        private const val ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        private val rng = SecureRandom()

        fun normalizeCode(raw: String): String =
            raw.uppercase().replace(Regex("[^A-Z0-9]"), "")

        fun generatePairingCode(): String {
            val sb = StringBuilder(6)
            repeat(6) {
                sb.append(ALPHABET[rng.nextInt(ALPHABET.length)])
            }
            return sb.toString()
        }
    }
}
