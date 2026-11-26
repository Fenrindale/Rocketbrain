package coroutinesfixture

object KotlinStringInspection {
    @JvmStatic
    fun main(args: Array<String>) {
        JavaStringInspection.waitForInspection()
        paused(JavaStringInspection.latin(), JavaStringInspection.wide(), JavaStringInspection.wide(), "short value")
    }

    @JvmStatic
    fun paused(latin: String, wide: String, other: String, shortValue: String) {
        JavaStringInspection.verifyAndRead(latin, wide, other, shortValue, "kotlin")
    }
}
