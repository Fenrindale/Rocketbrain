package kmpfixture

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PlatformTest {
    @Test fun overloads() {
        assertEquals("count=3", describe(3))
        assertEquals("TEST", describe("test"))
    }

    @Test fun matchesPlatform() {
        assertTrue(platformLabel in setOf("JVM", "JavaScript"))
        assertEquals("$platformLabel count=3 TEST", welcome())
    }
}
