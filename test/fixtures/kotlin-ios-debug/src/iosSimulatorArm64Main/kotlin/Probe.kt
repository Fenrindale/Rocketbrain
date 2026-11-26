package simulatorfixture

class Probe {
    fun measure(seed: Int): Int {
        val measured = seed + 2
        println("Rocketbrain Kotlin iOS measurement: " + measured) // debugger-stop
        return measured
    }
}
