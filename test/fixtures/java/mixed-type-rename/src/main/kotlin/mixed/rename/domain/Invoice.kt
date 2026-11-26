package mixed.rename.domain

class Invoice(val amount: Int) {
    fun render(prefix: String): String = prefix + amount
}
