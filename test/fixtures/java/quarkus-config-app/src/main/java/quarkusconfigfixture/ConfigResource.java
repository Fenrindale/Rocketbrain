package quarkusconfigfixture;

import jakarta.inject.Inject;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.WebApplicationException;
import jakarta.ws.rs.core.MediaType;
import java.sql.DriverManager;
import java.sql.SQLException;

@Path("/fixture-config")
@Produces(MediaType.TEXT_PLAIN)
public class ConfigResource {
    @Inject ServiceSettings settings;

    @GET
    public String configuration(){
        var listener=settings.listener();
        return listener.port()+","+listener.tls()+","+listener.timeout().map(value->value.toSeconds()).orElse(0L)+","+
            settings.tuning().retryCount()+","+settings.credentials().password().startsWith("fixture-private-");
    }

    @GET
    @Path("/lookup-count")
    public int lookups(){return FixtureSource.lookups();}

    @GET
    @Path("/jdbc")
    public int jdbc()throws SQLException {
        String url=System.getenv("RB_QUARKUS_TEST_JDBC_URL");
        if(url==null||!url.matches("jdbc:(?:mysql|mariadb)://127\\.0\\.0\\.1:[0-9]{4,5}/rocketbrain_fixture\\?(?:allowPublicKeyRetrieval=true&sslMode=DISABLED|useSsl=false)"))
            throw new WebApplicationException(404);
        try(var connection=DriverManager.getConnection(url,System.getenv("RB_QUARKUS_TEST_DB_USER"),System.getenv("RB_QUARKUS_TEST_DB_PASSWORD"));
            var statement=connection.prepareStatement("SELECT COUNT(*) FROM rb_spring_person");
            var rows=statement.executeQuery()){
            rows.next();return rows.getInt(1);
        }
    }
}
