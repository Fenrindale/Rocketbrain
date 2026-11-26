package quarkusgradlefixture;

import io.quarkus.test.junit.QuarkusTest;
import org.junit.jupiter.api.Test;
import static io.restassured.RestAssured.given;
import static org.hamcrest.CoreMatchers.equalTo;

@QuarkusTest
class FixtureResourceTest {
    @Test
    void runsWithTestProfile() {
        given().when().get("/proof").then().statusCode(200).body(equalTo("test-fixture-ready"));
    }

    @Test
    void reportsReadyHealth() {
        given().when().get("/q/health/ready").then().statusCode(200).body("status", equalTo("UP"));
    }
}
