package coroutinesfixture

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineName
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking

fun main() = runBlocking(CoroutineName("fixture-root")) {
    val pending = CompletableDeferred<Unit>()
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val suspended = launch(CoroutineName("awaiting-invoice"), start = CoroutineStart.UNDISPATCHED) {
        pending.await()
    }
    val running = launch(Dispatchers.Default + CoroutineName("processing-order")) {
        entered.countDown()
        release.await(90, TimeUnit.SECONDS)
    }
    try {
        check(entered.await(10, TimeUnit.SECONDS))
        println("Rocketbrain coroutine fixture ready")
        System.`in`.read()
        Unit
    } finally {
        release.countDown()
        suspended.cancelAndJoin()
        running.join()
    }
}
