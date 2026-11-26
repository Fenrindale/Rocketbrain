package micronautgradlefixture;

import io.micronaut.http.HttpStatus;
import io.micronaut.http.annotation.Controller;
import io.micronaut.http.annotation.Get;
import io.micronaut.http.exceptions.HttpStatusException;
import io.micronaut.scheduling.TaskExecutors;
import io.micronaut.scheduling.annotation.ExecuteOn;
import java.sql.DriverManager;
import java.sql.SQLException;

@Controller("/rocketbrain")
class FixtureController {
    private final GreetingConfiguration configuration;
    FixtureController(GreetingConfiguration configuration){this.configuration=configuration;}

    @Get("/hello")
    String hello(){return configuration.getMessage();}

    @Get("/jdbc")
    @ExecuteOn(TaskExecutors.BLOCKING)
    int jdbc()throws SQLException {
        String url=System.getenv("RB_MICRONAUT_JDBC_URL");
        if(url==null||!url.matches("jdbc:(?:mysql|mariadb)://127\\.0\\.0\\.1:[0-9]{4,5}/rocketbrain_fixture(?:\\?allowPublicKeyRetrieval=true&sslMode=DISABLED)?"))
            throw new HttpStatusException(HttpStatus.NOT_FOUND,"Owned database fixture is unavailable");
        try(var database=DriverManager.getConnection(url,System.getenv("RB_MICRONAUT_JDBC_USER"),System.getenv("RB_MICRONAUT_JDBC_PASSWORD"));
            var statement=database.prepareStatement("SELECT COUNT(*) FROM rb_spring_person");
            var rows=statement.executeQuery()){
            rows.next();
            return rows.getInt(1);
        }
    }
}
