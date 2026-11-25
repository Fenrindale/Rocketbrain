package micronautfixture;

import io.micronaut.http.client.HttpClient;
import io.micronaut.http.client.annotation.Client;
import io.micronaut.test.extensions.junit5.annotation.MicronautTest;
import jakarta.inject.Inject;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

@MicronautTest
class GreetingControllerTest {
    @Inject @Client("/") HttpClient http;

    @Test void configuredGreeting() {
        assertEquals("test-world?;test-world?;", http.toBlocking().retrieve("/greeting"));
    }

    @Test void configuredLength() {
        assertEquals("10", http.toBlocking().retrieve("/greeting/length"));
    }
}
