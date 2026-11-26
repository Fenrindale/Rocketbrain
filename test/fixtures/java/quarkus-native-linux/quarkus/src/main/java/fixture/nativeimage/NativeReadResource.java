package fixture.nativeimage;

import io.agroal.api.AgroalDataSource;
import io.quarkus.agroal.DataSource;
import jakarta.inject.Inject;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.NotFoundException;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import java.sql.SQLException;

@Path("/probe")
@Produces("text/plain")
public class NativeReadResource {
    @Inject @DataSource("mysql") AgroalDataSource mysql;
    @Inject @DataSource("mariadb") AgroalDataSource mariadb;

    @GET @Path("/{engine}")
    public String read(@PathParam("engine") String engine) throws SQLException {
        var source = switch(engine) {
            case "mysql" -> mysql;
            case "mariadb" -> mariadb;
            default -> throw new NotFoundException();
        };
        try (var connection = source.getConnection();
             var statement = connection.prepareStatement("SELECT COUNT(*), SUM(points), VERSION() FROM rb_native_people");
             var rows = statement.executeQuery()) {
            rows.next();
            String image = System.getProperty("org.graalvm.nativeimage.imagecode", "jvm");
            return image + "|" + rows.getInt(1) + "|" + rows.getInt(2) + "|" + rows.getString(3);
        }
    }
}
