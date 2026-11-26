package fixture.jpms.tests;

import fixture.jpms.app.InvoiceCounter;
import org.testng.annotations.DataProvider;
import org.testng.annotations.Test;

import static org.testng.Assert.*;

final class InvoiceModuleTest {
    @Test
    void runsInRealNamedModules() {
        assertEquals(getClass().getModule().getName(), "fixture.jpms.tests");
        assertEquals(InvoiceCounter.class.getModule().getName(), "fixture.jpms.app");
        assertEquals(Test.class.getModule().getName(), "org.testng");
        assertTrue(getClass().getModule().getLayer() == ModuleLayer.boot());
        assertTrue(getClass().getModule().isOpen("fixture.jpms.tests", Test.class.getModule()));
        assertTrue(ModuleLayer.boot().findModule("org.junit.jupiter.engine").isEmpty());
        try {
            Class.forName("org.junit.jupiter.api.Test", false, getClass().getClassLoader());
            fail("A named TestNG run must not use a Jupiter classpath.");
        } catch (ClassNotFoundException expected) {
            // Only the selected framework is present.
        }
    }

    @DataProvider
    private Object[][] invoiceCounts() {
        return new Object[][] { { 42 }, { 42 } };
    }

    @Test(dataProvider = "invoiceCounts")
    void executesSpringJdbc(int count) {
        var counter = new InvoiceCounter(System.getenv("RB_JPMS_JDBC_URL"),
            System.getenv("RB_JPMS_JDBC_USER"), System.getenv("RB_JPMS_JDBC_PASSWORD"));
        assertEquals(counter.count(), count);
        String version = counter.serverVersion();
        assertTrue(version.startsWith(System.getenv("RB_JPMS_EXPECTED_SERVER")), version);
        System.out.println("jpms-testng-spring-jdbc: " + version);
    }
}
