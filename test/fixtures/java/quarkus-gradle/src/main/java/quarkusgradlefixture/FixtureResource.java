package quarkusgradlefixture;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.WebApplicationException;
import jakarta.ws.rs.core.MediaType;
import java.sql.DriverManager;
import java.sql.SQLException;
import org.eclipse.microprofile.config.inject.ConfigProperty;

@Path("/proof")
@Produces(MediaType.TEXT_PLAIN)
public class FixtureResource {
    @ConfigProperty(name = "rocketbrain.greeting")
    String greeting;

    @GET
    public String greeting() {
        String message = greeting + "-ready";
        return message;
    }

    @GET
    @Path("/jdbc")
    public String readOwnedSpringRows() throws SQLException {
        String url = System.getenv("RB_QUARKUS_TEST_JDBC_URL");
        if (url == null || !url.matches("jdbc:(?:mysql|mariadb)://127\\.0\\.0\\.1:[0-9]{4,5}/rocketbrain_fixture\\?(?:allowPublicKeyRetrieval=true&sslMode=DISABLED|useSsl=false)"))
            throw new WebApplicationException(404);
        try (var connection = DriverManager.getConnection(url, System.getenv("RB_QUARKUS_TEST_DB_USER"), System.getenv("RB_QUARKUS_TEST_DB_PASSWORD"));
             var statement = connection.prepareStatement("SELECT COUNT(*) FROM rb_spring_person");
             var rows = statement.executeQuery()) {
            rows.next();
            return Integer.toString(rows.getInt(1));
        }
    }
}
