package nativefixture

import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.alloc
import kotlinx.cinterop.convert
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.reinterpret
import kotlinx.cinterop.sizeOf
import kotlinx.cinterop.usePinned
import platform.posix.AF_INET
import platform.posix.SOCK_STREAM
import platform.posix.close
import platform.posix.connect
import platform.posix.fclose
import platform.posix.fopen
import platform.posix.fputs
import platform.posix.htons
import platform.posix.inet_pton
import platform.posix.recv
import platform.posix.send
import platform.posix.sockaddr_in
import platform.posix.socket

@OptIn(ExperimentalForeignApi::class)
private fun springProbe(port: Int, engine: String): String = memScoped {
    val fd = socket(AF_INET, SOCK_STREAM.convert(), 0)
    check(fd >= 0)
    try {
        val address = alloc<sockaddr_in>()
        address.sin_family = AF_INET.convert()
        address.sin_port = htons(port.convert())
        check(inet_pton(AF_INET, "127.0.0.1", address.sin_addr.ptr) == 1)
        check(connect(fd, address.ptr.reinterpret(), sizeOf<sockaddr_in>().convert()) == 0)
        val request = ("GET /probe/" + engine + " HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").encodeToByteArray()
        request.usePinned { bytes ->
            var offset = 0
            while (offset < request.size) {
                val sent = send(fd, bytes.addressOf(offset), (request.size - offset).convert(), 0)
                check(sent > 0)
                offset += sent.toInt()
            }
        }
        val buffer = ByteArray(2048)
        val response = buildString {
            while (true) {
                val count = buffer.usePinned { bytes -> recv(fd, bytes.addressOf(0), buffer.size.convert(), 0) }
                if (count == 0L) break
                check(count > 0 && length < 32768)
                append(buffer.decodeToString(endIndex = count.toInt()))
            }
        }
        check(response.substringBefore("\r\n").contains(" 200 "))
        response.substringAfter("\r\n\r\n", "").trim()
    } finally {
        close(fd)
    }
}

@OptIn(ExperimentalForeignApi::class)
fun main(args: Array<String>) {
    check(args.size == 3)
    val port = args[0].toInt()
    val engine = args[1]
    check(port in 1..65535 && (engine == "mysql" || engine == "mariadb"))
    var total = 41
    total += 1 // BREAK_ON_UPDATE
    val probe = springProbe(port, engine) // STEP_TO_HTTP
    check(total == 42 && probe.startsWith("spring|2|42|"))
    // Inferior output must not reach the separate GDB/MI command stream.
    println("*stopped,reason=\"exited-normally\"")
    val receipt = requireNotNull(fopen(args[2], "w"))
    try {
        check(fputs(total.toString() + "|" + probe + "\n", receipt) >= 0)
    } finally {
        check(fclose(receipt) == 0)
    }
}
