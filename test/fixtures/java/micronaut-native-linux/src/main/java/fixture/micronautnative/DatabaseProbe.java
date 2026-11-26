package fixture.micronautnative;

import io.micronaut.context.env.Environment;
import io.micronaut.http.HttpStatus;
import io.micronaut.http.MediaType;
import io.micronaut.http.annotation.Controller;
import io.micronaut.http.annotation.Get;
import io.micronaut.http.annotation.PathVariable;
import io.micronaut.http.exceptions.HttpStatusException;
import io.micronaut.scheduling.TaskExecutors;
import io.micronaut.scheduling.annotation.ExecuteOn;
import jakarta.inject.Named;
import java.sql.SQLException;
import javax.sql.DataSource;

@Controller("/probe")
public class DatabaseProbe {
    private final DataSource mysql;
    private final DataSource mariadb;
    private final Environment environment;

    public DatabaseProbe(@Named("mysql") DataSource mysql, @Named("mariadb") DataSource mariadb, Environment environment) {
        this.mysql = mysql;
        this.mariadb = mariadb;
        this.environment = environment;
    }

    @Get(value = "/environment", produces = MediaType.TEXT_PLAIN)
    public String environment() {
        return environment.getActiveNames().contains("dev") ? "dev" : "other";
    }

    @Get(value = "/{engine}", produces = MediaType.TEXT_PLAIN)
    @ExecuteOn(TaskExecutors.BLOCKING)
    public String rows(@PathVariable("engine") String engine) throws SQLException {
        DataSource source = switch (engine) {
            case "mysql" -> mysql;
            case "mariadb" -> mariadb;
            default -> throw new HttpStatusException(HttpStatus.NOT_FOUND, "Unknown fixture engine");
        };
        try (var connection = source.getConnection();
             var statement = connection.prepareStatement("SELECT COUNT(*), SUM(points), VERSION() FROM rb_native_people");
             var result = statement.executeQuery()) {
            if (!result.next()) throw new SQLException("No fixture aggregate returned");
            return System.getProperty("org.graalvm.nativeimage.imagecode", "jvm") + "|" + result.getInt(1)
                    + "|" + result.getInt(2) + "|" + result.getString(3);
        } catch (SQLException | RuntimeException failure) {
            failure.printStackTrace(System.err);
            throw failure;
        }
    }
}
