package quarkusfixture;

import io.quarkus.test.junit.QuarkusTest;
import org.junit.jupiter.api.Test;

import static io.restassured.RestAssured.given;
import static org.hamcrest.CoreMatchers.containsString;
import static org.hamcrest.CoreMatchers.equalTo;

@QuarkusTest
class GreetingResourceTest {
    @Test
    void typedProfileAndDefault() {
        given().when().get("/greeting").then().statusCode(200).body(equalTo("test-world!;test-world!;"));
    }

    @Test
    void rendersQuteOverHttp() {
        given().when().get("/greeting/page").then().statusCode(200).body(containsString("<p class=\"greeting\">test-world!</p>"));
    }
}
