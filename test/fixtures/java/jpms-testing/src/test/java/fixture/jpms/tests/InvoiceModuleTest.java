package fixture.jpms.tests;

import fixture.jpms.app.InvoiceCounter;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

final class InvoiceModuleTest {
    @Test
    void runsInRealNamedModules() {
        assertEquals("fixture.jpms.tests", getClass().getModule().getName());
        assertEquals("fixture.jpms.app", InvoiceCounter.class.getModule().getName());
        assertEquals("org.junit.jupiter.api", Test.class.getModule().getName());
        assertTrue(getClass().getModule().getLayer() == ModuleLayer.boot());
    }

    @Test
    void executesSpringJdbc() {
        var counter = new InvoiceCounter(System.getenv("RB_JPMS_JDBC_URL"),
            System.getenv("RB_JPMS_JDBC_USER"), System.getenv("RB_JPMS_JDBC_PASSWORD"));
        assertEquals(42, counter.count());
        String version = counter.serverVersion();
        assertTrue(version.startsWith(System.getenv("RB_JPMS_EXPECTED_SERVER")), version);
        System.out.println("jpms-spring-jdbc: " + version);
    }
}
