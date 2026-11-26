package coroutinesfixture

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

object KotlinWatchInspection {
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
            paused(amount, 9007199254740993L, caption, missing, boxed, true, side,
                numbers, captions, mutable, singleton, immutable, nested, null, WatchTrapList(side))
            println("Rocketbrain Kotlin JDBC|" + version + "|" + amount + "|" + side.calls)
        }
    }

    @JvmStatic
    fun paused(amount: Int, large: Long, caption: String?, missing: String?, boxed: Int?, enabled: Boolean,
               side: WatchSideEffect, numbers: IntArray, captions: List<String?>, mutable: List<Int?>,
               singleton: List<Long?>, immutable: List<Long>, nested: Array<IntArray>, absentList: List<Int>?, trap: List<Int>) {
        val subtotal = amount + 2 * 3
        val precise = large + amount
        val length = caption?.length ?: 0
        val fallback = missing?.length ?: amount + 1
        val boolean = enabled && caption == "receipt" && boxed == 7
        check(numbers[0] == amount && captions[1] == null && mutable[1] == amount)
        check(singleton.size == 1 && immutable.size == 3 && nested[0] === numbers && absentList == null)
        check(trap is WatchTrapList)
        check(side.calls == 0)
        println("Rocketbrain Kotlin evaluated|" + subtotal + "|" + precise + "|" + length + "|" + fallback + "|" + boolean)
    }
}
