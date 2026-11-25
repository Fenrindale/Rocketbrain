package editor.fixture

fun summarize(invoice: Invoice): String {
    val number = invoice.number
    return number.uppercase()
}
