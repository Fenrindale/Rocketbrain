package coroutinesfixture

import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DriverManagerDataSource

class WatchSideEffect {
    var calls = 0
    fun mutate(): Int { calls++; return calls }
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
            paused(amount, 9007199254740993L, caption, missing, boxed, true, side)
            println("Rocketbrain Kotlin JDBC|" + version + "|" + amount + "|" + side.calls)
        }
    }

    @JvmStatic
    fun paused(amount: Int, large: Long, caption: String?, missing: String?, boxed: Int?, enabled: Boolean, side: WatchSideEffect) {
        val subtotal = amount + 2 * 3
        val precise = large + amount
        val length = caption?.length ?: 0
        val fallback = missing?.length ?: amount + 1
        val boolean = enabled && caption == "receipt" && boxed == 7
        check(side.calls == 0)
        println("Rocketbrain Kotlin evaluated|" + subtotal + "|" + precise + "|" + length + "|" + fallback + "|" + boolean)
    }
}
