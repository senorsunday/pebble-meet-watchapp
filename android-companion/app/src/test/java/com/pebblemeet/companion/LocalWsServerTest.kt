package com.pebblemeet.companion

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class LocalWsServerTest {

    @Test
    fun computeAcceptKeyMatchesRfc6455Vector() {
        assertEquals(
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
            LocalWsServer.computeAcceptKey("dGhlIHNhbXBsZSBub25jZQ==")
        )
    }

    @Test
    fun roundTripMessagesOverLocalhost() {
        val serverReceived = AtomicReference<String>()
        val clientReceived = AtomicReference<String>()
        val serverLatch = CountDownLatch(1)
        val clientLatch = CountDownLatch(1)
        val openLatch = CountDownLatch(1)

        val server = LocalWsServer(
            port = 0,
            onMessage = { msg ->
                serverReceived.set(msg)
                serverLatch.countDown()
            },
            onClientCountChanged = {}
        )
        server.start()

        try {
            val client = OkHttpClient()
            val req = Request.Builder()
                .url("ws://127.0.0.1:${server.boundPort()}/?room=LOCAL&role=pebble")
                .build()

            val ws = client.newWebSocket(req, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    openLatch.countDown()
                    webSocket.send("""{"cmd":"TOGGLE_MUTE","muted":true}""")
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    clientReceived.set(text)
                    clientLatch.countDown()
                }
            })

            assertTrue("WebSocket should open", openLatch.await(5, TimeUnit.SECONDS))
            assertTrue("Server should receive client frame", serverLatch.await(5, TimeUnit.SECONDS))
            assertEquals("""{"cmd":"TOGGLE_MUTE","muted":true}""", serverReceived.get())

            assertTrue(server.broadcast("""{"type":"MEET_STATE","muted":true}"""))
            assertTrue("Client should receive server broadcast", clientLatch.await(5, TimeUnit.SECONDS))
            assertEquals("""{"type":"MEET_STATE","muted":true}""", clientReceived.get())

            ws.close(1000, "done")
            client.dispatcher.executorService.shutdown()
        } finally {
            server.stop()
        }
    }
}
