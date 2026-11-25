package kmpfixture

actual val platformLabel: String = "JavaScript"
actual fun describe(value: Int): String = "count=$value"
actual fun describe(value: String): String = value.uppercase()
