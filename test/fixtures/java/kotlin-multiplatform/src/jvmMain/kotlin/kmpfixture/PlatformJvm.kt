package kmpfixture

actual val platformLabel: String = "JVM"
actual fun describe(value: String): String = value.uppercase()
actual fun describe(value: Int): String = "count=$value"
