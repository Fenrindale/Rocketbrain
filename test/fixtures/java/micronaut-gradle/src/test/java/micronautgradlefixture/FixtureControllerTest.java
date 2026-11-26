package micronautgradlefixture;

import io.micronaut.http.client.HttpClient;
import io.micronaut.http.client.annotation.Client;
import io.micronaut.test.extensions.junit5.annotation.MicronautTest;
import jakarta.inject.Inject;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

@MicronautTest
class FixtureControllerTest {
    @Inject @Client("/") HttpClient client;

    @Test void readsTestEnvironmentFromActualRunningApplication(){
        assertEquals("gradle-test",client.toBlocking().retrieve("/rocketbrain/hello"));
    }
}
