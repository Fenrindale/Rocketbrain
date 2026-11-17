package fixture.boot;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
class RunnerOutcomeTest {
    @Test void toggledFailure() {
        assertEquals("expected",Boolean.getBoolean("rocketbrain.fixture.fail")?"actual":"expected","Controlled failure for native test status and rerun verification");
    }
    @Test void alwaysPasses() {assertTrue(true);}
}
