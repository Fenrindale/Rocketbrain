package coroutinesfixture

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineName
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import javax.sql.DataSource

private fun CoroutineScope.parkSharedBody(mark: String, gate: CompletableDeferred<Unit>) =
    launch(CoroutineName("same-name"), start = CoroutineStart.UNDISPATCHED) {
        gate.await()
        println("Rocketbrain coroutine " + mark + " resumed")
    }

private fun jdbcReadback() {
    val jdbcUrl = System.getenv("RB_COROUTINE_JDBC_URL") ?: return
    val dataSource = Class.forName("org.springframework.jdbc.datasource.DriverManagerDataSource")
        .getConstructor(String::class.java, String::class.java, String::class.java)
        .newInstance(jdbcUrl, System.getenv("RB_COROUTINE_JDBC_USER"), System.getenv("RB_COROUTINE_JDBC_PASSWORD"))
    val jdbcType = Class.forName("org.springframework.jdbc.core.JdbcTemplate")
    val jdbc = jdbcType.getConstructor(DataSource::class.java).newInstance(dataSource)
    val query = jdbcType.getMethod("queryForObject", String::class.java, Class::class.java)
    val version = query.invoke(jdbc, "SELECT VERSION()", String::class.java)
    val amount = query.invoke(jdbc, "SELECT 42", Int::class.javaObjectType)
    println("Rocketbrain coroutine JDBC|" + version + "|" + amount)
}

object CoroutineWatch {
    @JvmStatic
    fun main(args: Array<String>) = runBlocking(CoroutineName("watch-root")) {
        val selected = CompletableDeferred<Unit>()
        val sibling = CompletableDeferred<Unit>()
        val selectedParent = launch(Dispatchers.Default + CoroutineName("selected-parent"), start = CoroutineStart.UNDISPATCHED) {
            parkSharedBody("selected", selected).join()
        }
        val siblingParent = launch(Dispatchers.Default + CoroutineName("sibling-parent"), start = CoroutineStart.UNDISPATCHED) {
            parkSharedBody("sibling", sibling).join()
        }
        val input = System.`in`.bufferedReader()
        println("Rocketbrain coroutine fixture ready")
        while (true) {
            when (input.readLine()) {
                "selected" -> selected.complete(Unit)
                "sibling" -> sibling.complete(Unit)
                "status" -> {
                    jdbcReadback()
                    println("Rocketbrain coroutine fixture still running")
                }
                else -> break
            }
        }
        selected.complete(Unit)
        sibling.complete(Unit)
        selectedParent.join()
        siblingParent.join()
    }
}
