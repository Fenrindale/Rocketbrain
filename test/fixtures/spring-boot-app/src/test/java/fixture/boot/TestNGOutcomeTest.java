package fixture.boot;
import org.testng.annotations.Test;
import static org.testng.Assert.*;
public class TestNGOutcomeTest {
    @Test public void toggledFailure(){assertEquals(Boolean.getBoolean("rocketbrain.fixture.fail")?"actual":"expected","expected","Controlled TestNG assertion failure");}
    @Test(dependsOnMethods="toggledFailure") public void dependent(){assertTrue(true);}
}
