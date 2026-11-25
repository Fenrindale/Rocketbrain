package kmpfixture

expect val platformLabel: String
expect fun describe(value: Int): String
expect fun describe(value: String): String

fun welcome(): String = "${platformLabel} ${describe(3)} ${describe("test")}"
