package com.pebblemeet.companion

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Lightweight RFC-6455 WebSocket server bound strictly to 127.0.0.1 for
 * 100% local, zero-cloud phone-only mode on Android / GrapheneOS.
 */
class LocalWsServer(
    private val port: Int = CompanionStore.LOCAL_WS_PORT,
    private val onMessage: (String) -> Unit,
    private val onClientCountChanged: (Int) -> Unit
) {
    private val running = AtomicBoolean(false)
    private var serverSocket: ServerSocket? = null
    private var acceptThread: Thread? = null
    private val clients = CopyOnWriteArrayList<ClientConnection>()

    fun start() {
        if (!running.compareAndSet(false, true)) return
        val ss = ServerSocket(port, 8, InetAddress.getByName("127.0.0.1"))
        ss.reuseAddress = true
        serverSocket = ss
        acceptThread = Thread({
            while (running.get()) {
                try {
                    val socket = ss.accept()
                    Thread({ handleClient(socket) }, "PebbleMeet-LocalWS-Client").start()
                } catch (_: Exception) {
                    if (!running.get()) break
                }
            }
        }, "PebbleMeet-LocalWS-Accept").apply { start() }
    }

    fun stop() {
        if (!running.compareAndSet(true, false)) return
        try {
            serverSocket?.close()
        } catch (_: Exception) {
        }
        serverSocket = null
        clients.forEach { it.close() }
        clients.clear()
        onClientCountChanged(0)
    }

    fun boundPort(): Int = serverSocket?.localPort ?: port

    fun clientCount(): Int = clients.size

    fun broadcast(text: String): Boolean {
        if (clients.isEmpty()) return false
        var sentAny = false
        for (client in clients) {
            if (client.sendText(text)) {
                sentAny = true
            }
        }
        return sentAny
    }

    private fun handleClient(socket: Socket) {
        var conn: ClientConnection? = null
        try {
            socket.tcpNoDelay = true
            val input = BufferedInputStream(socket.getInputStream())
            val output = socket.getOutputStream()

            val headers = readHttpHeaders(input) ?: return
            val wsKey = headers["sec-websocket-key"] ?: return
            val acceptKey = computeAcceptKey(wsKey)

            val response =
                "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Upgrade: websocket\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Sec-WebSocket-Accept: $acceptKey\r\n\r\n"
            output.write(response.toByteArray(StandardCharsets.US_ASCII))
            output.flush()

            conn = ClientConnection(socket, output)
            clients.add(conn)
            onClientCountChanged(clients.size)

            while (running.get() && !socket.isClosed) {
                val frame = readFrame(input) ?: break
                when (frame.opcode) {
                    OPCODE_TEXT -> {
                        val payloadStr = String(frame.payload, StandardCharsets.UTF_8)
                        onMessage(payloadStr)
                    }
                    OPCODE_PING -> conn.sendFrame(OPCODE_PONG, frame.payload)
                    OPCODE_CLOSE -> {
                        conn.sendFrame(OPCODE_CLOSE, ByteArray(0))
                        break
                    }
                }
            }
        } catch (_: Exception) {
            // Client disconnected
        } finally {
            if (conn != null) {
                clients.remove(conn)
                conn.close()
                onClientCountChanged(clients.size)
            } else {
                try {
                    socket.close()
                } catch (_: Exception) {
                }
            }
        }
    }

    private fun readHttpHeaders(input: InputStream): Map<String, String>? {
        val buf = ByteArrayOutputStream()
        var prev3 = 0
        var prev2 = 0
        var prev1 = 0
        while (buf.size() < 8192) {
            val b = input.read()
            if (b == -1) return null
            buf.write(b)
            if (prev3 == '\r'.code && prev2 == '\n'.code && prev1 == '\r'.code && b == '\n'.code) {
                break
            }
            prev3 = prev2
            prev2 = prev1
            prev1 = b
        }
        val raw = buf.toString(StandardCharsets.US_ASCII.name())
        val lines = raw.split("\r\n")
        if (lines.isEmpty() || !lines[0].startsWith("GET ")) return null
        val map = mutableMapOf<String, String>()
        for (i in 1 until lines.size) {
            val idx = lines[i].indexOf(':')
            if (idx > 0) {
                val k = lines[i].substring(0, idx).trim().lowercase()
                val v = lines[i].substring(idx + 1).trim()
                map[k] = v
            }
        }
        return map
    }

    private fun readExact(input: InputStream, count: Int): ByteArray {
        val out = ByteArray(count)
        var offset = 0
        while (offset < count) {
            val n = input.read(out, offset, count - offset)
            if (n == -1) throw EOFException("Unexpected EOF")
            offset += n
        }
        return out
    }

    private fun readFrame(input: InputStream): WsFrame? {
        val b0 = input.read()
        if (b0 == -1) return null
        val b1 = input.read()
        if (b1 == -1) return null

        val opcode = b0 and 0x0F
        val masked = (b1 and 0x80) != 0
        var length = (b1 and 0x7F).toLong()

        if (length == 126L) {
            val ext = readExact(input, 2)
            length = (((ext[0].toInt() and 0xFF) shl 8) or (ext[1].toInt() and 0xFF)).toLong()
        } else if (length == 127L) {
            val ext = readExact(input, 8)
            length = 0L
            for (i in 0 until 8) {
                length = (length shl 8) or (ext[i].toLong() and 0xFFL)
            }
        }
        if (length < 0 || length > MAX_FRAME_BYTES) return null

        val maskKey = if (masked) readExact(input, 4) else null
        val payload = readExact(input, length.toInt())
        if (maskKey != null) {
            for (i in payload.indices) {
                payload[i] = (payload[i].toInt() xor maskKey[i % 4].toInt()).toByte()
            }
        }
        return WsFrame(opcode, payload)
    }

    private data class WsFrame(val opcode: Int, val payload: ByteArray)

    private class ClientConnection(
        private val socket: Socket,
        private val output: OutputStream
    ) {
        private val writeLock = Any()

        fun sendText(text: String): Boolean =
            sendFrame(OPCODE_TEXT, text.toByteArray(StandardCharsets.UTF_8))

        fun sendFrame(opcode: Int, payload: ByteArray): Boolean {
            return synchronized(writeLock) {
                try {
                    val header = ByteArrayOutputStream()
                    header.write(0x80 or (opcode and 0x0F))
                    val len = payload.size
                    when {
                        len <= 125 -> header.write(len)
                        len <= 65535 -> {
                            header.write(126)
                            header.write((len shr 8) and 0xFF)
                            header.write(len and 0xFF)
                        }
                        else -> {
                            header.write(127)
                            val l = len.toLong()
                            for (shift in 56 downTo 0 step 8) {
                                header.write(((l ushr shift) and 0xFFL).toInt())
                            }
                        }
                    }
                    output.write(header.toByteArray())
                    output.write(payload)
                    output.flush()
                    true
                } catch (_: Exception) {
                    close()
                    false
                }
            }
        }

        fun close() {
            try {
                socket.close()
            } catch (_: Exception) {
            }
        }
    }

    companion object {
        private const val WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        private const val OPCODE_TEXT = 0x1
        private const val OPCODE_CLOSE = 0x8
        private const val OPCODE_PING = 0x9
        private const val OPCODE_PONG = 0xA
        private const val MAX_FRAME_BYTES = 64 * 1024

        fun computeAcceptKey(secWebSocketKey: String): String {
            val sha1 = MessageDigest.getInstance("SHA-1")
            val digest = sha1.digest((secWebSocketKey.trim() + WS_GUID).toByteArray(StandardCharsets.US_ASCII))
            return Base64.getEncoder().encodeToString(digest)
        }
    }
}
