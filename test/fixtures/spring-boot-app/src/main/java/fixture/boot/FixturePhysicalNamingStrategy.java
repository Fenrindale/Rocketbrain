package fixture.boot;

import java.util.Locale;
import org.hibernate.boot.model.naming.Identifier;
import org.hibernate.boot.model.naming.PhysicalNamingStrategyStandardImpl;
import org.hibernate.engine.jdbc.env.spi.JdbcEnvironment;

/** A pure, source-inspectable fixture. Enabled only for the v0.6 custom run. */
public class FixturePhysicalNamingStrategy extends PhysicalNamingStrategyStandardImpl {
    @Override
    public Identifier toPhysicalTableName(Identifier name, JdbcEnvironment context) {
        return transform(name, "v6_");
    }

    @Override
    public Identifier toPhysicalColumnName(Identifier name, JdbcEnvironment context) {
        return transform(name, "c_");
    }

    private Identifier transform(Identifier name, String prefix) {
        if (name == null || name.isQuoted()) return name;
        String text = name.getText().replaceAll("([a-z0-9])([A-Z])", "$1_$2").toLowerCase(Locale.ROOT);
        return Identifier.toIdentifier(prefix + text, name.isQuoted());
    }
}
