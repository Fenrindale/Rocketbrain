package mixed.fixture;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class JavaApplicationTest {
    @Test void crossLanguagePipeline() {
        assertEquals("mixed-14-3:kotlin", JavaApplication.execute(7));
        assertEquals("text-value", new KotlinGateway().transform("value"));
    }
}
