package mixed.fixture

class KotlinGateway : JavaHelper() {
    val name: String = "kotlin"

    fun transform(number: Int): String {
        return JavaHelper.render(number * 2) + "-" + this.count
    }

    fun transform(value: String): String {
        return JavaHelper.render(value)
    }
}
