package fixture.arc;

import java.sql.DriverManager;
import java.sql.SQLException;
import jakarta.enterprise.inject.AmbiguousResolutionException;
import jakarta.enterprise.inject.Any;
import jakarta.enterprise.inject.Instance;
import jakarta.enterprise.inject.UnsatisfiedResolutionException;
import jakarta.enterprise.inject.literal.NamedLiteral;
import jakarta.inject.Inject;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.WebApplicationException;
import jakarta.ws.rs.core.MediaType;

@Path("/fixture-arc")
@Produces(MediaType.TEXT_PLAIN)
public class ArcResource {
    @Inject @Any Instance<ArcService> portal;

    @GET @Path("/lookup/{action}")
    public String lookup(@PathParam("action") String action){
        try{
            return switch(action){
                case "left","right","conflict","missing" -> Integer.toString(portal.select(new Choice.Literal("fixture-private-"+action)).get().marker());
                case "gated","field","reflected" -> Integer.toString(portal.select(NamedLiteral.of("fixture-private-"+action)).get().marker());
                case "handle" -> {
                    try(var handle=portal.select(new Choice.Literal("fixture-private-left")).getHandle()){
                        yield "handle";
                    }
                }
                default -> throw new WebApplicationException(404);
            };
        }catch(AmbiguousResolutionException ignored){return "ambiguous";}
        catch(UnsatisfiedResolutionException ignored){return "unsatisfied";}
    }
    @GET @Path("/counts")
    public String counts(){return Producers.calls()+","+GateSource.reads();}

    @GET @Path("/jdbc")
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
