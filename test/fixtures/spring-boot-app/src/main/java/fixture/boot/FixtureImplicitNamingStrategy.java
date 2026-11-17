package fixture.boot;

import org.hibernate.boot.model.naming.Identifier;
import org.hibernate.boot.model.naming.ImplicitBasicColumnNameSource;
import org.hibernate.boot.model.naming.ImplicitNamingStrategyJpaCompliantImpl;

/** Changes only unnamed basic columns; explicitly declared names bypass this SPI. */
public class FixtureImplicitNamingStrategy extends ImplicitNamingStrategyJpaCompliantImpl {
    @Override
    public Identifier determineBasicColumnName(ImplicitBasicColumnNameSource source) {
        return toIdentifier("logical_" + source.getAttributePath().getProperty(), source.getBuildingContext());
    }
}
