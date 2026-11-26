package editormaven.fixture

import org.springframework.context.annotation.AnnotationConfigApplicationContext
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DriverManagerDataSource

fun orderSummary(invoice: Invoice, jdbc: JdbcTemplate): String {
    val number = invoice.number
    val amount: Int = requireNotNull(jdbc.queryForObject("SELECT 42", Int::class.javaObjectType))
    return "$number/$amount"
}

fun main() {
    val dataSource = DriverManagerDataSource(
        requireNotNull(System.getenv("RB_KOTLIN_MAVEN_JDBC_URL")),
        requireNotNull(System.getenv("RB_KOTLIN_MAVEN_JDBC_USER")),
        requireNotNull(System.getenv("RB_KOTLIN_MAVEN_JDBC_PASSWORD"))
    )
    AnnotationConfigApplicationContext().use { context ->
        context.beanFactory.registerSingleton("jdbcTemplate", JdbcTemplate(dataSource))
        context.refresh()
        val jdbc = context.getBean(JdbcTemplate::class.java)
        val server = jdbc.queryForObject("SELECT VERSION()", String::class.java)
        println("Rocketbrain Kotlin Maven JDBC|$server|${orderSummary(Invoice("invoice"), jdbc)}")
    }
}
