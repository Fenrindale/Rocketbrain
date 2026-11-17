package fixture.boot;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.hibernate.boot.model.naming.Identifier;
import org.hibernate.boot.model.naming.PhysicalNamingStrategyStandardImpl;
import org.hibernate.engine.jdbc.env.spi.JdbcEnvironment;
/** Deliberately outside the source interpreter: proves runtime observation of arbitrary naming code. */
public class OpaquePhysicalNamingStrategy extends PhysicalNamingStrategyStandardImpl {
    private Identifier observed(Identifier logical, String prefix) {
        if(logical==null||logical.isQuoted())return logical;
        String hash=UUID.nameUUIDFromBytes(logical.getText().getBytes(StandardCharsets.UTF_8)).toString().replace("-","");
        return Identifier.toIdentifier(prefix+hash.substring(0,20));
    }
    @Override public Identifier toPhysicalTableName(Identifier name,JdbcEnvironment context){return observed(name,"rt_");}
    @Override public Identifier toPhysicalColumnName(Identifier name,JdbcEnvironment context){return observed(name,"rc_");}
}
