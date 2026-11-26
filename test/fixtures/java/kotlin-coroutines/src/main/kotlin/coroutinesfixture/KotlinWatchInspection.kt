package coroutinesfixture

import java.nio.file.Files
import java.nio.file.Path
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DriverManagerDataSource

class WatchSideEffect {
    var calls = 0
    fun mutate(): Int { calls++; return calls }
}

private class WatchTrapList(private val side: WatchSideEffect) : AbstractList<Int>() {
    override val size: Int get() = side.mutate()
    override fun get(index: Int): Int = side.mutate()
}

class WatchObject(private val side: WatchSideEffect) {
    var count = 4
    @JvmField var isOpen = true
    var exact = 9007199254740993L
    var nullable: Int? = null
    val storedBox: Int? = 7
    val constant = 13
    var guarded = 11
        set(value) { side.mutate(); field = value }
    var computed: Int
        get() = side.mutate()
        set(value) { if (value > 0) side.mutate() }
    val delegated by lazy { side.mutate() }
    companion object { @JvmField var global = 1 }
}

object KotlinWatchInspection {
    private fun allowFixtureFieldChange(target: WatchObject) {
        val signalName = System.getenv("RB_KOTLIN_TEST_FIELD_SIGNAL") ?: return
        val signal = Path.of(signalName)
        val worker = Thread {
            val deadline = System.nanoTime() + 50_000_000_000L
            while (System.nanoTime() < deadline) {
                if (Files.isRegularFile(signal)) {
                    target.count = 34
                    println("Rocketbrain Kotlin field changed by fixture")
                    return@Thread
                }
                Thread.sleep(25)
            }
        }
        worker.isDaemon = true
        worker.start()
    }

    @JvmStatic
    fun main(args: Array<String>) {
        val jdbc = JdbcTemplate(DriverManagerDataSource(
            requireNotNull(System.getenv("RB_COROUTINE_JDBC_URL")),
            requireNotNull(System.getenv("RB_COROUTINE_JDBC_USER")),
            requireNotNull(System.getenv("RB_COROUTINE_JDBC_PASSWORD"))
        ))
        val input = System.`in`.bufferedReader()
        println("Rocketbrain coroutine fixture ready")
        while (input.readLine() == "inspect") {
            val amount = requireNotNull(jdbc.queryForObject("SELECT 42", Int::class.javaObjectType))
            val caption = jdbc.queryForObject("SELECT 'receipt'", String::class.java)
            val missing = jdbc.queryForObject("SELECT CAST(NULL AS CHAR)", String::class.java)
            val boxed: Int? = jdbc.queryForObject("SELECT 7", Int::class.javaObjectType)
            val version = jdbc.queryForObject("SELECT VERSION()", String::class.java)
            val side = WatchSideEffect()
            val numbers = intArrayOf(amount, requireNotNull(boxed))
            val captions = listOf(caption, null, "edge")
            val mutable = arrayListOf(boxed, amount)
            val singleton = java.util.Collections.singletonList<Long?>(null)
            val immutable = java.util.List.of(9007199254740993L, 3L, 5L)
            val nested = arrayOf(numbers, intArrayOf(0))
            val target = WatchObject(side)
            allowFixtureFieldChange(target)
            paused(amount, 9007199254740993L, caption, missing, boxed, true, side,
                numbers, captions, mutable, singleton, immutable, nested, null, WatchTrapList(side), target, WatchObject(side), 113)
            println("Rocketbrain Kotlin JDBC|" + version + "|" + amount + "|" + side.calls)
        }
    }

    @JvmStatic
    fun paused(amount: Int, large: Long, caption: String?, missing: String?, boxed: Int?, enabled: Boolean,
               side: WatchSideEffect, numbers: IntArray, captions: List<String?>, mutable: List<Int?>,
               singleton: List<Long?>, immutable: List<Long>, nested: Array<IntArray>, absentList: List<Int>?, trap: List<Int>,
               target: WatchObject, other: WatchObject, replacementBox: Int?) {
        val subtotal = amount + 2 * 3
        val precise = large + amount
        val length = caption?.length ?: 0
        val fallback = missing?.length ?: amount + 1
        val boolean = enabled && caption == "receipt" && boxed == 7
        check(numbers[0] == amount && captions[1] == null && mutable[1] == amount)
        check(singleton.size == 1 && immutable.size == 3 && nested[0] === numbers && absentList == null)
        check(trap is WatchTrapList)
        check(side.calls == 0)
        check(replacementBox == 113)
        println("Rocketbrain Kotlin Fields|" + target.count + "|" + target.isOpen + "|" + target.exact + "|" +
            target.nullable + "|" + other.count + "|" + side.calls)
        println("Rocketbrain Kotlin evaluated|" + subtotal + "|" + precise + "|" + length + "|" + fallback + "|" + boolean)
    }
}
